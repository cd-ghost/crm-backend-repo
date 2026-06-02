import type { NextFunction, Request, Response } from 'express';
import type { AccessScope, Role } from '../types';

/** Map a role to its data-visibility scope. */
export function scopeForRole(role: Role): AccessScope {
  switch (role) {
    case 'ADMIN':
    case 'MANAGER':
      // Full visibility across the tenant's records.
      return { viewAll: true, restrictToOwner: false };
    case 'SALES_REP':
      // May only touch records it owns.
      return { viewAll: false, restrictToOwner: true };
    default: {
      // Exhaustiveness guard: fails to compile if a new role is added without
      // an explicit scope mapping here.
      const _exhaustive: never = role;
      throw new Error(`Unhandled role: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Inject `req.accessScope` based on the authenticated principal's role. Must run
 * after `authenticateJWT`. The route handlers consult this scope to decide
 * whether to constrain queries to records owned by the caller.
 */
export function injectAccessScope(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  req.accessScope = scopeForRole(req.user.role);
  next();
}

/** Guard a route so only the listed roles may proceed. */
export function requireRole(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!allowed.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}
