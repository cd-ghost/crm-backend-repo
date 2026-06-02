import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import { asyncHandler } from '../middleware/asyncHandler';
import { HttpError } from '../middleware/errorHandler';
import { authenticateJWT } from '../middleware/authenticate';
import { injectAccessScope } from '../middleware/authorize';
import { executeTenantQuery } from '../db/context';
import { parseOpportunityWorkbook } from '../import/opportunityImport';
import type { Opportunity } from '../types';

export const opportunitiesRouter = Router();

opportunitiesRouter.use(authenticateJWT, injectAccessScope);

const OPP_COLUMNS = 'id, tenant_id, owner_id, name, account_name, stage, estimated_revenue, created_at';

interface OpportunityBody {
  name?: unknown;
  account_name?: unknown;
  stage?: unknown;
  estimated_revenue?: unknown;
  owner_id?: unknown;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, `Field "${field}" is required`);
  }
  return value.trim();
}

function parseRevenue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString();
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/[$,\s]/g, '');
    if (cleaned !== '' && !Number.isNaN(Number(cleaned))) {
      return cleaned;
    }
  }
  throw new HttpError(400, 'Field "estimated_revenue" must be a valid number');
}

const ALLOWED_EXTENSIONS = ['.xlsx', '.csv'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const lower = file.originalname.toLowerCase();
    if (ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      cb(null, true);
    } else {
      cb(new HttpError(400, 'Only .xlsx or .csv files are accepted'));
    }
  },
});

/** GET /api/opportunities — list opportunities, owner-scoped for SALES_REP. */
opportunitiesRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!;
    const scope = req.accessScope!;

    let text = `SELECT ${OPP_COLUMNS} FROM opportunities`;
    const params: unknown[] = [];
    if (scope.restrictToOwner) {
      params.push(userId);
      text += ` WHERE owner_id = $${params.length}`;
    }
    text += ' ORDER BY created_at DESC';

    const result = await executeTenantQuery<Opportunity>(tenantId, text, params);
    res.json({ opportunities: result.rows });
  }),
);

/** GET /api/opportunities/:id — fetch one opportunity, owner-scoped for SALES_REP. */
opportunitiesRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!;
    const scope = req.accessScope!;

    const params: unknown[] = [req.params.id];
    let text = `SELECT ${OPP_COLUMNS} FROM opportunities WHERE id = $1`;
    if (scope.restrictToOwner) {
      params.push(userId);
      text += ` AND owner_id = $${params.length}`;
    }

    const result = await executeTenantQuery<Opportunity>(tenantId, text, params);
    const opportunity = result.rows[0];
    if (!opportunity) {
      throw new HttpError(404, 'Opportunity not found');
    }
    res.json({ opportunity });
  }),
);

/** POST /api/opportunities — create a single opportunity. SALES_REP owns its own records. */
opportunitiesRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!;
    const scope = req.accessScope!;
    const body = req.body as OpportunityBody;

    const name = requireNonEmptyString(body.name, 'name');
    const accountName = requireNonEmptyString(body.account_name, 'account_name');
    const stage = requireNonEmptyString(body.stage, 'stage');
    const revenue = parseRevenue(body.estimated_revenue);

    let ownerId = userId;
    if (!scope.restrictToOwner && typeof body.owner_id === 'string' && body.owner_id.length > 0) {
      ownerId = body.owner_id;
    }

    const result = await executeTenantQuery<Opportunity>(
      tenantId,
      `INSERT INTO opportunities (tenant_id, owner_id, name, account_name, stage, estimated_revenue)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${OPP_COLUMNS}`,
      [tenantId, ownerId, name, accountName, stage, revenue],
    );
    res.status(201).json({ opportunity: result.rows[0]! });
  }),
);

/** PUT /api/opportunities/:id — update an opportunity, owner-scoped for SALES_REP. */
opportunitiesRouter.put(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!;
    const scope = req.accessScope!;
    const body = req.body as OpportunityBody;

    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, value: unknown): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };

    if (body.name !== undefined) {
      add('name', requireNonEmptyString(body.name, 'name'));
    }
    if (body.account_name !== undefined) {
      add('account_name', requireNonEmptyString(body.account_name, 'account_name'));
    }
    if (body.stage !== undefined) {
      add('stage', requireNonEmptyString(body.stage, 'stage'));
    }
    if (body.estimated_revenue !== undefined) {
      add('estimated_revenue', parseRevenue(body.estimated_revenue));
    }
    if (sets.length === 0) {
      throw new HttpError(400, 'No updatable fields provided');
    }

    params.push(req.params.id);
    let text = `UPDATE opportunities SET ${sets.join(', ')} WHERE id = $${params.length}`;
    if (scope.restrictToOwner) {
      params.push(userId);
      text += ` AND owner_id = $${params.length}`;
    }
    text += ` RETURNING ${OPP_COLUMNS}`;

    const result = await executeTenantQuery<Opportunity>(tenantId, text, params);
    const opportunity = result.rows[0];
    if (!opportunity) {
      throw new HttpError(404, 'Opportunity not found');
    }
    res.json({ opportunity });
  }),
);

/** DELETE /api/opportunities/:id — delete an opportunity, owner-scoped for SALES_REP. */
opportunitiesRouter.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!;
    const scope = req.accessScope!;

    const params: unknown[] = [req.params.id];
    let text = 'DELETE FROM opportunities WHERE id = $1';
    if (scope.restrictToOwner) {
      params.push(userId);
      text += ` AND owner_id = $${params.length}`;
    }
    text += ' RETURNING id';

    const result = await executeTenantQuery<{ id: string }>(tenantId, text, params);
    if (result.rowCount === 0) {
      throw new HttpError(404, 'Opportunity not found');
    }
    res.status(204).send();
  }),
);

/**
 * POST /api/opportunities/import — bulk import opportunities from an uploaded
 * .xlsx/.csv file.
 *
 * Flow: parse + validate every row; if ANY cell fails, abort and return a
 * targeted per-row/cell error report (nothing is written). Otherwise inject the
 * caller's tenant_id/owner_id from the JWT and perform a single set-based
 * `unnest` bulk insert inside `executeTenantQuery`, so the entire batch runs in
 * one RLS-scoped transaction (rolled back on any failure).
 */
opportunitiesRouter.post(
  '/import',
  upload.single('file'),
  asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!;

    if (!req.file) {
      throw new HttpError(400, 'Expected a file upload in the "file" field');
    }

    const { rows, errors } = parseOpportunityWorkbook(req.file.buffer);

    if (errors.length > 0) {
      // Hard abort: do not insert anything. Report exactly which row/cell failed.
      res.status(422).json({
        error: 'Validation failed; no rows were imported',
        imported: 0,
        errors,
      });
      return;
    }

    // Inject the authenticated tenant/owner into every validated row, then
    // bulk-insert via unnest within the RLS transaction wrapper.
    const names = rows.map((r) => r.name);
    const accounts = rows.map((r) => r.account_name);
    const stages = rows.map((r) => r.stage);
    const revenues = rows.map((r) => r.estimated_revenue);

    const result = await executeTenantQuery<{ id: string }>(
      tenantId,
      `INSERT INTO opportunities (tenant_id, owner_id, name, account_name, stage, estimated_revenue)
       SELECT $1, $2, n, a, s, r
       FROM unnest($3::text[], $4::text[], $5::text[], $6::numeric[]) AS t(n, a, s, r)
       RETURNING id`,
      [tenantId, userId, names, accounts, stages, revenues],
    );

    res.status(201).json({
      imported: result.rowCount ?? result.rows.length,
      ids: result.rows.map((row) => row.id),
    });
  }),
);
