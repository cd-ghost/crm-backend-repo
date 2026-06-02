import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app';
import { closePool } from '../src/config/pool';
import { executeTenantQuery } from '../src/db/context';

const app = createApp();

async function bootstrapTenantWithLead(): Promise<{ tenantId: string; leadId: string }> {
  const email = `admin-${randomUUID()}@example.com`;
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ companyName: `Co-${randomUUID()}`, email, password: 'Sup3rSecret!' });
  expect(reg.status).toBe(201);
  const token = reg.body.token as string;

  const lead = await request(app)
    .post('/api/leads')
    .set('Authorization', `Bearer ${token}`)
    .send({ first_name: 'RLS', last_name: 'Check' });
  expect(lead.status).toBe(201);

  return { tenantId: reg.body.user.tenant_id as string, leadId: lead.body.lead.id as string };
}

afterAll(async () => {
  await closePool();
});

describe('Row-Level Security enforced at the database layer', () => {
  it('hides another tenant\'s rows from a raw SELECT (no owner filter)', async () => {
    const a = await bootstrapTenantWithLead();
    const b = await bootstrapTenantWithLead();

    // Raw, unfiltered query under tenant A's GUC sees A's lead...
    const asA = await executeTenantQuery<{ id: string }>(
      a.tenantId,
      'SELECT id FROM leads',
    );
    expect(asA.rows.map((r) => r.id)).toContain(a.leadId);

    // ...but the SAME raw query under tenant B's GUC cannot see A's lead.
    const asB = await executeTenantQuery<{ id: string }>(
      b.tenantId,
      'SELECT id FROM leads',
    );
    expect(asB.rows.map((r) => r.id)).not.toContain(a.leadId);
  });

  it('blocks inserting a row for a different tenant (RLS WITH CHECK)', async () => {
    const a = await bootstrapTenantWithLead();
    const otherTenantId = randomUUID();

    // Attempt to insert a lead tagged with a different tenant_id than the GUC.
    await expect(
      executeTenantQuery(
        a.tenantId,
        `INSERT INTO leads (tenant_id, owner_id, first_name, last_name)
         VALUES ($1, $1, 'Bad', 'Actor')`,
        [otherTenantId],
      ),
    ).rejects.toThrow();
  });
});
