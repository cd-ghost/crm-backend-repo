import { Router } from 'express';
import type { Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { HttpError } from '../middleware/errorHandler';
import { authenticateJWT } from '../middleware/authenticate';
import { injectAccessScope } from '../middleware/authorize';
import { executeTenantQuery } from '../db/context';
import { LEAD_STATUSES } from '../domain/enums';
import type { Lead, LeadStatus } from '../types';

export const leadsRouter = Router();

// Every leads endpoint requires a valid JWT and a computed access scope.
leadsRouter.use(authenticateJWT, injectAccessScope);

const LEAD_COLUMNS = 'id, tenant_id, owner_id, first_name, last_name, status, created_at';

interface LeadBody {
  first_name?: unknown;
  last_name?: unknown;
  status?: unknown;
  owner_id?: unknown;
}

function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === 'string' && (LEAD_STATUSES as readonly string[]).includes(value);
}

/**
 * GET /api/leads — list leads in the tenant. RLS already restricts rows to the
 * caller's tenant; SALES_REP scope additionally appends `WHERE owner_id = $1`.
 */
leadsRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!;
    const scope = req.accessScope!;

    let text = `SELECT ${LEAD_COLUMNS} FROM leads`;
    const params: unknown[] = [];
    if (scope.restrictToOwner) {
      params.push(userId);
      text += ` WHERE owner_id = $${params.length}`;
    }
    text += ' ORDER BY created_at DESC';

    const result = await executeTenantQuery<Lead>(tenantId, text, params);
    res.json({ leads: result.rows });
  }),
);

/** GET /api/leads/:id — fetch one lead, owner-scoped for SALES_REP. */
leadsRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!;
    const scope = req.accessScope!;

    const params: unknown[] = [req.params.id];
    let text = `SELECT ${LEAD_COLUMNS} FROM leads WHERE id = $1`;
    if (scope.restrictToOwner) {
      params.push(userId);
      text += ` AND owner_id = $${params.length}`;
    }

    const result = await executeTenantQuery<Lead>(tenantId, text, params);
    const lead = result.rows[0];
    if (!lead) {
      throw new HttpError(404, 'Lead not found');
    }
    res.json({ lead });
  }),
);

/** POST /api/leads — create a lead. SALES_REP can only create leads they own. */
leadsRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!;
    const scope = req.accessScope!;
    const body = req.body as LeadBody;

    if (typeof body.first_name !== 'string' || body.first_name.trim().length === 0) {
      throw new HttpError(400, 'Field "first_name" is required');
    }
    if (typeof body.last_name !== 'string' || body.last_name.trim().length === 0) {
      throw new HttpError(400, 'Field "last_name" is required');
    }
    const status: LeadStatus = body.status === undefined ? 'NEW' : (isLeadStatus(body.status)
      ? body.status
      : (() => {
          throw new HttpError(400, `Invalid "status"; allowed: ${LEAD_STATUSES.join(', ')}`);
        })());

    // Owner assignment: privileged roles may assign to any user in the tenant;
    // a SALES_REP is always forced to own its own records.
    let ownerId = userId;
    if (!scope.restrictToOwner && typeof body.owner_id === 'string' && body.owner_id.length > 0) {
      ownerId = body.owner_id;
    }

    const result = await executeTenantQuery<Lead>(
      tenantId,
      `INSERT INTO leads (tenant_id, owner_id, first_name, last_name, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${LEAD_COLUMNS}`,
      [tenantId, ownerId, body.first_name.trim(), body.last_name.trim(), status],
    );
    res.status(201).json({ lead: result.rows[0]! });
  }),
);

/** PUT /api/leads/:id — update a lead, owner-scoped for SALES_REP. */
leadsRouter.put(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!;
    const scope = req.accessScope!;
    const body = req.body as LeadBody;

    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, value: unknown): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };

    if (body.first_name !== undefined) {
      if (typeof body.first_name !== 'string' || body.first_name.trim().length === 0) {
        throw new HttpError(400, 'Field "first_name" must be a non-empty string');
      }
      add('first_name', body.first_name.trim());
    }
    if (body.last_name !== undefined) {
      if (typeof body.last_name !== 'string' || body.last_name.trim().length === 0) {
        throw new HttpError(400, 'Field "last_name" must be a non-empty string');
      }
      add('last_name', body.last_name.trim());
    }
    if (body.status !== undefined) {
      if (!isLeadStatus(body.status)) {
        throw new HttpError(400, `Invalid "status"; allowed: ${LEAD_STATUSES.join(', ')}`);
      }
      add('status', body.status);
    }
    if (sets.length === 0) {
      throw new HttpError(400, 'No updatable fields provided');
    }

    params.push(req.params.id);
    let text = `UPDATE leads SET ${sets.join(', ')} WHERE id = $${params.length}`;
    if (scope.restrictToOwner) {
      params.push(userId);
      text += ` AND owner_id = $${params.length}`;
    }
    text += ` RETURNING ${LEAD_COLUMNS}`;

    const result = await executeTenantQuery<Lead>(tenantId, text, params);
    const lead = result.rows[0];
    if (!lead) {
      throw new HttpError(404, 'Lead not found');
    }
    res.json({ lead });
  }),
);

/** DELETE /api/leads/:id — delete a lead, owner-scoped for SALES_REP. */
leadsRouter.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!;
    const scope = req.accessScope!;

    const params: unknown[] = [req.params.id];
    let text = 'DELETE FROM leads WHERE id = $1';
    if (scope.restrictToOwner) {
      params.push(userId);
      text += ` AND owner_id = $${params.length}`;
    }
    text += ' RETURNING id';

    const result = await executeTenantQuery<{ id: string }>(tenantId, text, params);
    if (result.rowCount === 0) {
      throw new HttpError(404, 'Lead not found');
    }
    res.status(204).send();
  }),
);
