export type Role = 'ADMIN' | 'MANAGER' | 'SALES_REP';

export const ROLES: readonly Role[] = ['ADMIN', 'MANAGER', 'SALES_REP'] as const;

export type LeadStatus = 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'LOST' | 'WON';

export type DealStage =
  | 'PROSPECTING'
  | 'NEGOTIATION'
  | 'PROPOSAL'
  | 'CLOSED_WON'
  | 'CLOSED_LOST';

/** Authenticated principal extracted from a validated JWT. */
export interface AuthUser {
  userId: string;
  tenantId: string;
  role: Role;
}

/**
 * Access scope derived from the principal's role. Injected by the RBAC
 * middleware onto `req.accessScope` and consumed by the route handlers to
 * decide whether to constrain queries to records owned by the caller.
 */
export interface AccessScope {
  /** True when the role may read every record within its tenant. */
  viewAll: boolean;
  /** True when the role may only access records where owner_id === userId. */
  restrictToOwner: boolean;
}

export interface Tenant {
  id: string;
  company_name: string;
  is_active: boolean;
  created_at: Date;
}

export interface User {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  role: Role;
  created_at: Date;
}

/** A `User` row safe to return over the wire (no password hash). */
export type SafeUser = Omit<User, 'password_hash'>;

export interface Lead {
  id: string;
  tenant_id: string;
  owner_id: string;
  first_name: string;
  last_name: string;
  status: LeadStatus;
  created_at: Date;
}

export interface Deal {
  id: string;
  tenant_id: string;
  lead_id: string;
  owner_id: string;
  amount: string;
  stage: DealStage;
  created_at: Date;
}

export interface JwtPayloadShape {
  userId: string;
  tenantId: string;
  role: Role;
}
