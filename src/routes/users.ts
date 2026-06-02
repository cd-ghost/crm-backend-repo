import { Router } from 'express';
import type { Request, Response } from 'express';
import { pool } from '../config/pool';
import { asyncHandler } from '../middleware/asyncHandler';
import { HttpError } from '../middleware/errorHandler';
import { authenticateJWT } from '../middleware/authenticate';
import { requireRole } from '../middleware/authorize';
import { hashPassword } from '../auth/security';
import { ROLES } from '../types';
import type { Role, SafeUser, User } from '../types';

export const usersRouter = Router();

usersRouter.use(authenticateJWT);

interface CreateUserBody {
  email?: unknown;
  password?: unknown;
  role?: unknown;
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** List users in the caller's tenant. ADMIN and MANAGER only. */
usersRouter.get(
  '/',
  requireRole('ADMIN', 'MANAGER'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const result = await pool.query<SafeUser>(
      `SELECT id, tenant_id, email, role, created_at
       FROM users WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    res.json({ users: result.rows });
  }),
);

/** Provision a new user within the caller's tenant. ADMIN only. */
usersRouter.post(
  '/',
  requireRole('ADMIN'),
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const body = req.body as CreateUserBody;

    if (typeof body.email !== 'string' || body.email.trim().length === 0) {
      throw new HttpError(400, 'Field "email" is required');
    }
    if (typeof body.password !== 'string' || body.password.length === 0) {
      throw new HttpError(400, 'Field "password" is required');
    }
    if (!isRole(body.role)) {
      throw new HttpError(400, `Field "role" must be one of: ${ROLES.join(', ')}`);
    }

    const email = body.email.trim().toLowerCase();
    const passwordHash = await hashPassword(body.password);

    try {
      const result = await pool.query<User>(
        `INSERT INTO users (tenant_id, email, password_hash, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, tenant_id, email, role, created_at`,
        [tenantId, email, passwordHash, body.role],
      );
      res.status(201).json({ user: result.rows[0]! as SafeUser });
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
        throw new HttpError(409, 'Email already registered');
      }
      throw err;
    }
  }),
);
