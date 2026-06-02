import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Application } from 'express';
import { createApp } from '../src/app';
import { closePool } from '../src/config/pool';

const app: Application = createApp();

interface Registered {
  token: string;
  tenantId: string;
  adminId: string;
}

async function registerTenant(): Promise<Registered> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({
      companyName: `Co-${randomUUID()}`,
      email: `admin-${randomUUID()}@example.com`,
      password: 'Sup3rSecret!',
    });
  expect(res.status).toBe(201);
  return {
    token: res.body.token as string,
    tenantId: res.body.user.tenant_id as string,
    adminId: res.body.user.id as string,
  };
}

async function createRep(adminToken: string): Promise<{ token: string; userId: string }> {
  const email = `rep-${randomUUID()}@example.com`;
  const password = 'R3pPassword!';
  const created = await request(app)
    .post('/api/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email, password, role: 'SALES_REP' });
  expect(created.status).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  expect(login.status).toBe(200);
  return { token: login.body.token as string, userId: created.body.user.id as string };
}

async function createOpportunity(
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await request(app)
    .post('/api/opportunities')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
  return { status: res.status, body: res.body as Record<string, unknown> };
}

afterAll(async () => {
  await closePool();
});

describe('Opportunities CRUD + SALES_REP owner isolation', () => {
  let admin: Registered;
  let repA: { token: string; userId: string };
  let repB: { token: string; userId: string };
  let oppId: string;

  beforeAll(async () => {
    admin = await registerTenant();
    repA = await createRep(admin.token);
    repB = await createRep(admin.token);

    const created = await createOpportunity(repA.token, {
      name: 'Enterprise Deal',
      account_name: 'Globex',
      stage: 'PROSPECTING',
      estimated_revenue: '$12,500.50',
    });
    expect(created.status).toBe(201);
    const opportunity = created.body.opportunity as Record<string, unknown>;
    oppId = opportunity.id as string;
    // Owner is forced to the creating SALES_REP, and currency formatting normalizes.
    expect(opportunity.owner_id).toBe(repA.userId);
    expect(opportunity.estimated_revenue).toBe('12500.50');
  });

  it('rejects creation when a mandatory field is missing (400)', async () => {
    const res = await createOpportunity(repA.token, {
      name: 'No Revenue',
      account_name: 'Initech',
      stage: 'PROSPECTING',
    });
    expect(res.status).toBe(400);
  });

  it('lets the owning SALES_REP read its opportunity (200)', async () => {
    const res = await request(app)
      .get(`/api/opportunities/${oppId}`)
      .set('Authorization', `Bearer ${repA.token}`);
    expect(res.status).toBe(200);
    expect(res.body.opportunity.id).toBe(oppId);
  });

  it('forbids another SALES_REP from reading it (404)', async () => {
    const res = await request(app)
      .get(`/api/opportunities/${oppId}`)
      .set('Authorization', `Bearer ${repB.token}`);
    expect(res.status).toBe(404);
  });

  it('excludes it from another rep\'s list query', async () => {
    const res = await request(app)
      .get('/api/opportunities')
      .set('Authorization', `Bearer ${repB.token}`);
    expect(res.status).toBe(200);
    const ids = (res.body.opportunities as Array<{ id: string }>).map((o) => o.id);
    expect(ids).not.toContain(oppId);
  });

  it('forbids another rep from updating it (404) and leaves it intact', async () => {
    const res = await request(app)
      .put(`/api/opportunities/${oppId}`)
      .set('Authorization', `Bearer ${repB.token}`)
      .send({ stage: 'CLOSED_WON' });
    expect(res.status).toBe(404);

    const owner = await request(app)
      .get(`/api/opportunities/${oppId}`)
      .set('Authorization', `Bearer ${repA.token}`);
    expect(owner.body.opportunity.stage).toBe('PROSPECTING');
  });

  it('lets the owner update it (200)', async () => {
    const res = await request(app)
      .put(`/api/opportunities/${oppId}`)
      .set('Authorization', `Bearer ${repA.token}`)
      .send({ stage: 'PROPOSAL', estimated_revenue: 9000 });
    expect(res.status).toBe(200);
    expect(res.body.opportunity.stage).toBe('PROPOSAL');
    expect(res.body.opportunity.estimated_revenue).toBe('9000.00');
  });

  it('lets ADMIN read every opportunity in the tenant (viewAll)', async () => {
    const res = await request(app)
      .get('/api/opportunities')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    const ids = (res.body.opportunities as Array<{ id: string }>).map((o) => o.id);
    expect(ids).toContain(oppId);
  });

  it('forbids another rep from deleting it (404)', async () => {
    const res = await request(app)
      .delete(`/api/opportunities/${oppId}`)
      .set('Authorization', `Bearer ${repB.token}`);
    expect(res.status).toBe(404);
  });

  it('lets the owner delete it (204) and it is then gone', async () => {
    const del = await request(app)
      .delete(`/api/opportunities/${oppId}`)
      .set('Authorization', `Bearer ${repA.token}`);
    expect(del.status).toBe(204);

    const after = await request(app)
      .get(`/api/opportunities/${oppId}`)
      .set('Authorization', `Bearer ${repA.token}`);
    expect(after.status).toBe(404);
  });
});

describe('Opportunities cross-tenant isolation (RLS)', () => {
  it('prevents one tenant from reading another tenant\'s opportunity', async () => {
    const tenant1 = await registerTenant();
    const tenant2 = await registerTenant();

    const created = await createOpportunity(tenant1.token, {
      name: 'Tenant1 Opp',
      account_name: 'Acme',
      stage: 'PROSPECTING',
      estimated_revenue: 1000,
    });
    expect(created.status).toBe(201);
    const oppId = (created.body.opportunity as Record<string, unknown>).id as string;

    const byId = await request(app)
      .get(`/api/opportunities/${oppId}`)
      .set('Authorization', `Bearer ${tenant2.token}`);
    expect(byId.status).toBe(404);
  });
});
