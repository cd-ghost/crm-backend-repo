import { Router } from 'express';
import type { Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { HttpError } from '../middleware/errorHandler';
import { authenticateJWT } from '../middleware/authenticate';
import { injectAccessScope } from '../middleware/authorize';
import { executeTenantQuery } from '../db/context';
import { DEAL_STAGES } from '../domain/enums';
import type { Deal, DealStage } from '../types';

export const dealsRouter = Router();

dealsRouter.use(authenticateJWT, injectAccessScope);

const DEAL_COLUMNS = 'id, tenant_id, lead_id, owner_id, amount, stage, created_at';

interface DealBody {
  lead_id?: unknown;
  amount?: unknown;
  stage?: unknown;
  owner_id?: unknown;
}

function isDealStage(value: unknown): value is DealStage {
  return typeof value === 'string' && (DEAL_STAGES as readonly string[]).includes(value);
}

function parseAmount(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString();
  }
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return value.trim();
  }
  throw new HttpError(400, 'Field "amount" must be a valid number');
}

/** GET /api/deals — list deals, owner-scoped for SALES_REP. */
dealsRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!;
    const scope = req.accessScope!;

    let text = `SELECT ${DEAL_COLUMNS} FROM deals`;
    const params: unknown[] = [];
    if (scope.restrictToOwner) {
      params.push(userId);
      text += ` WHERE owner_id = $${params.length}`;
    }
    text += ' ORDER BY created_at DESC';

    const result = await executeTenantQuery<Deal>(tenantId, text, params);
    res.json({ deals: result.rows });
  }),
);

/** GET /api/deals/:id — fetch one deal, owner-scoped for SALES_REP. */
dealsRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!;
    const scope = req.accessScope!;

    const params: unknown[] = [req.params.id];
    let text = `SELECT ${DEAL_COLUMNS} FROM deals WHERE id = $1`;
    if (scope.restrictToOwner) {
      params.push(userId);
      text += ` AND owner_id = $${params.length}`;
    }

    const result = await executeTenantQuery<Deal>(tenantId, text, params);
    const deal = result.rows[0];
    if (!deal) {
      throw new HttpError(404, 'Deal not found');
    }
    res.json({ deal });
  }),
);

/** POST /api/deals — create a deal. SALES_REP can only create deals they own. */
dealsRouter.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!;
    const scope = req.accessScope!;
    const body = req.body as DealBody;

    if (typeof body.lead_id !== 'string' || body.lead_id.trim().length === 0) {
      throw new HttpError(400, 'Field "lead_id" is required');
    }
    const amount = parseAmount(body.amount);
    const stage: DealStage = body.stage === undefined ? 'PROSPECTING' : (isDealStage(body.stage)
      ? body.stage
      : (() => {
          throw new HttpError(400, `Invalid "stage"; allowed: ${DEAL_STAGES.join(', ')}`);
        })());

    let ownerId = userId;
    if (!scope.restrictToOwner && typeof body.owner_id === 'string' && body.owner_id.length > 0) {
      ownerId = body.owner_id;
    }

    const result = await executeTenantQuery<Deal>(
      tenantId,
      `INSERT INTO deals (tenant_id, lead_id, owner_id, amount, stage)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${DEAL_COLUMNS}`,
      [tenantId, body.lead_id.trim(), ownerId, amount, stage],
    );
    res.status(201).json({ deal: result.rows[0]! });
  }),
);

/** PUT /api/deals/:id — update a deal, owner-scoped for SALES_REP. */
dealsRouter.put(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!;
    const scope = req.accessScope!;
    const body = req.body as DealBody;

    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, value: unknown): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };

    if (body.amount !== undefined) {
      add('amount', parseAmount(body.amount));
    }
    if (body.stage !== undefined) {
      if (!isDealStage(body.stage)) {
        throw new HttpError(400, `Invalid "stage"; allowed: ${DEAL_STAGES.join(', ')}`);
      }
      add('stage', body.stage);
    }
    if (body.lead_id !== undefined) {
      if (typeof body.lead_id !== 'string' || body.lead_id.trim().length === 0) {
        throw new HttpError(400, 'Field "lead_id" must be a non-empty string');
      }
      add('lead_id', body.lead_id.trim());
    }
    if (sets.length === 0) {
      throw new HttpError(400, 'No updatable fields provided');
    }

    params.push(req.params.id);
    let text = `UPDATE deals SET ${sets.join(', ')} WHERE id = $${params.length}`;
    if (scope.restrictToOwner) {
      params.push(userId);
      text += ` AND owner_id = $${params.length}`;
    }
    text += ` RETURNING ${DEAL_COLUMNS}`;

    const result = await executeTenantQuery<Deal>(tenantId, text, params);
    const deal = result.rows[0];
    if (!deal) {
      throw new HttpError(404, 'Deal not found');
    }
    res.json({ deal });
  }),
);

/** DELETE /api/deals/:id — delete a deal, owner-scoped for SALES_REP. */
dealsRouter.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { tenantId, userId } = req.user!;
    const scope = req.accessScope!;

    const params: unknown[] = [req.params.id];
    let text = 'DELETE FROM deals WHERE id = $1';
    if (scope.restrictToOwner) {
      params.push(userId);
      text += ` AND owner_id = $${params.length}`;
    }
    text += ' RETURNING id';

    const result = await executeTenantQuery<{ id: string }>(tenantId, text, params);
    if (result.rowCount === 0) {
      throw new HttpError(404, 'Deal not found');
    }
    res.status(204).send();
  }),
);
