-- Multi-tenant CRM schema with PostgreSQL Row-Level Security (RLS).
--
-- Tenant isolation is enforced at the database layer: the application sets a
-- transaction-local GUC `app.current_tenant_id` (via SET LOCAL) and the RLS
-- policies below restrict every row operation on `leads` and `deals` to the
-- matching tenant. This guarantees isolation even if an application query
-- forgets a WHERE tenant_id = ... clause.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Application role
-- ---------------------------------------------------------------------------
-- The API MUST connect as this role, never as a superuser or table owner.
-- Superusers and roles with BYPASSRLS ignore Row-Level Security entirely, so a
-- dedicated NOSUPERUSER / NOBYPASSRLS login is what makes the tenant isolation
-- policies below actually enforceable. Password is overridable via the
-- CRM_APP_PASSWORD psql variable (defaults to a local-dev value).
DO $$
DECLARE
  app_pw text := COALESCE(NULLIF(current_setting('crm.app_password', true), ''), 'crm_app_pw');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    EXECUTE format('CREATE ROLE crm_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', app_pw);
  ELSE
    EXECUTE format('ALTER ROLE crm_app WITH LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS', app_pw);
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('ADMIN', 'MANAGER', 'SALES_REP');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_status') THEN
    CREATE TYPE lead_status AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'LOST', 'WON');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'deal_stage') THEN
    CREATE TYPE deal_stage AS ENUM ('PROSPECTING', 'NEGOTIATION', 'PROPOSAL', 'CLOSED_WON', 'CLOSED_LOST');
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'SALES_REP',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);

CREATE TABLE IF NOT EXISTS leads (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  status     lead_status NOT NULL DEFAULT 'NEW',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_id ON leads(tenant_id);
CREATE INDEX IF NOT EXISTS idx_leads_owner_id ON leads(owner_id);

CREATE TABLE IF NOT EXISTS deals (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id    UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  stage      deal_stage NOT NULL DEFAULT 'PROSPECTING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deals_tenant_id ON deals(tenant_id);
CREATE INDEX IF NOT EXISTS idx_deals_owner_id ON deals(owner_id);
CREATE INDEX IF NOT EXISTS idx_deals_lead_id ON deals(lead_id);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
-- Helper: read the transaction-local tenant id as UUID. Returns NULL when the
-- GUC is unset so policies fail closed (no rows match a NULL comparison).
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid;
$$;

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_leads ON leads;
CREATE POLICY tenant_isolation_leads ON leads
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_deals ON deals;
CREATE POLICY tenant_isolation_deals ON deals
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- Privileges for the application role
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO crm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, users, leads, deals TO crm_app;
GRANT EXECUTE ON FUNCTION current_tenant_id() TO crm_app;
