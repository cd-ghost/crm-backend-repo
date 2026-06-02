-- Opportunities table for the bulk-import engine. Like leads/deals, tenant
-- isolation is enforced by Row-Level Security bound to app.current_tenant_id,
-- so the batch INSERT performed inside executeTenantQuery cannot write rows for
-- any other tenant (RLS WITH CHECK) and reads are tenant-scoped.

CREATE TABLE IF NOT EXISTS opportunities (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  account_name      TEXT NOT NULL,
  stage             TEXT NOT NULL,
  estimated_revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_opportunities_tenant_id ON opportunities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_owner_id ON opportunities(owner_id);

ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_opportunities ON opportunities;
CREATE POLICY tenant_isolation_opportunities ON opportunities
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON opportunities TO crm_app;
