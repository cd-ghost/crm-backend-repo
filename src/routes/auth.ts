import { Router } from 'express';
import type { Request, Response } from 'express';
import { pool } from '../config/pool';
import { asyncHandler } from '../middleware/asyncHandler';
import { HttpError } from '../middleware/errorHandler';
import { hashPassword, signToken, verifyPassword } from '../auth/security';
import type { Role, SafeUser, User } from '../types';

export const authRouter = Router();

interface RegisterBody {
  companyName?: unknown;
  email?: unknown;
  password?: unknown;
}

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, `Field "${field}" is required`);
  }
  return value.trim();
}

/**
 * Bootstrap a new tenant. Creates the tenant row and its first user as an
 * ADMIN, then returns a signed JWT. Subsequent users are provisioned by an
 * authenticated ADMIN through the /api/users route.
 */
authRouter.post(
  '/register',
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as RegisterBody;
    const companyName = asNonEmptyString(body.companyName, 'companyName');
    const email = asNonEmptyString(body.email, 'email').toLowerCase();
    const password = asNonEmptyString(body.password, 'password');

    const passwordHash = await hashPassword(password);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query('SELECT 1 FROM users WHERE email = $1', [email]);
      if (existing.rowCount && existing.rowCount > 0) {
        throw new HttpError(409, 'Email already registered');
      }

      const tenantResult = await client.query<{ id: string }>(
        'INSERT INTO tenants (company_name) VALUES ($1) RETURNING id',
        [companyName],
      );
      const tenantId = tenantResult.rows[0]!.id;

      const role: Role = 'ADMIN';
      const userResult = await client.query<User>(
        `INSERT INTO users (tenant_id, email, password_hash, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, tenant_id, email, role, created_at`,
        [tenantId, email, passwordHash, role],
      );
      await client.query('COMMIT');

      const user = userResult.rows[0]!;
      const token = signToken({ userId: user.id, tenantId, role });
      res.status(201).json({ token, user: user as SafeUser });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }),
);

/** Authenticate by email + password and return a signed JWT on success. */
authRouter.post(
  '/login',
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as LoginBody;
    const email = asNonEmptyString(body.email, 'email').toLowerCase();
    const password = asNonEmptyString(body.password, 'password');

    const result = await pool.query<User>(
      `SELECT id, tenant_id, email, password_hash, role, created_at
       FROM users WHERE email = $1`,
      [email],
    );
    const user = result.rows[0];
    // Generic message + hash comparison regardless of existence to avoid
    // leaking which emails are registered (and to limit timing differences).
    if (!user) {
      throw new HttpError(401, 'Invalid credentials');
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      throw new HttpError(401, 'Invalid credentials');
    }

    const token = signToken({
      userId: user.id,
      tenantId: user.tenant_id,
      role: user.role,
    });
    res.json({
      token,
      user: {
        id: user.id,
        tenant_id: user.tenant_id,
        email: user.email,
        role: user.role,
        created_at: user.created_at,
      } satisfies SafeUser,
    });
  }),
);
