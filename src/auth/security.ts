import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { config } from '../config/env';
import { ROLES } from '../types';
import type { AuthUser, JwtPayloadShape, Role } from '../types';

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, config.bcryptSaltRounds);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Sign a stateless JWT carrying the tenant + role claims used for AuthZ. */
export function signToken(payload: JwtPayloadShape): string {
  // Cast the whole literal: jsonwebtoken types `expiresIn` as a branded
  // StringValue union that a plain string is not directly assignable to.
  const options = { expiresIn: config.jwtExpiresIn } as SignOptions;
  return jwt.sign(payload, config.jwtSecret, options);
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * Verify a token's signature/expiry and return a strongly-typed principal.
 * Throws if the token is invalid or the payload is malformed.
 */
export function verifyToken(token: string): AuthUser {
  const decoded = jwt.verify(token, config.jwtSecret);
  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('Invalid token payload');
  }
  const { userId, tenantId, role } = decoded as Record<string, unknown>;
  if (typeof userId !== 'string' || typeof tenantId !== 'string' || !isRole(role)) {
    throw new Error('Invalid token claims');
  }
  return { userId, tenantId, role };
}
