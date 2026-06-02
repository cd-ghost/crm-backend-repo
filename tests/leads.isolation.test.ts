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

/** Register a brand-new tenant; the first user is its ADMIN. */
async function registerTenant(): Promise<Registered> {
  const email = `admin-${randomUUID()}@example.com`;
  const res = await request(app)
    .post('/api/auth/register')
    .send({ companyName: `Co-${randomUUID()}`, email, password: 'Sup3rSecret!' });
  expect(res.status).toBe(201);
  return {
    token: res.body.token as string,
    tenantId: res.body.user.tenant_id as string,
    adminId: res.body.user.id as string,
  };
}

/** Create a user in the admin's tenant and log them in, returning a token. */
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

async function createLead(token: string, firstName: string): Promise<string> {
  const res = await request(app)
    .post('/api/leads')
    .set('Authorization', `Bearer ${token}`)
    .send({ first_name: firstName, last_name: 'Doe' });
  expect(res.status).toBe(201);
  return res.body.lead.id as string;
}

afterAll(async () => {
  await closePool();
});

describe('Lead routing: SALES_REP owner isolation (same tenant)', () => {
  let admin: Registered;
  let repA: { token: string; userId: string };
  let repB: { token: string; userId: string };
  let repALeadId: string;

  beforeAll(async () => {
    admin = await registerTenant();
    repA = await createRep(admin.token);
    repB = await createRep(admin.token);
    repALeadId = await createLead(repA.token, 'OwnedByA');
  });

  it('lets a SALES_REP read a lead they own', async () => {
    const res = await request(app)
      .get(`/api/leads/${repALeadId}`)
      .set('Authorization', `Bearer ${repA.token}`);
    expect(res.status).toBe(200);
    expect(res.body.lead.id).toBe(repALeadId);
    expect(res.body.lead.owner_id).toBe(repA.userId);
  });

  it('forbids a SALES_REP from reading another rep\'s lead (404, not found)', async () => {
    const res = await request(app)
      .get(`/api/leads/${repALeadId}`)
      .set('Authorization', `Bearer ${repB.token}`);
    expect(res.status).toBe(404);
  });

  it('excludes other reps\' leads from a SALES_REP list query', async () => {
    const res = await request(app)
      .get('/api/leads')
      .set('Authorization', `Bearer ${repB.token}`);
    expect(res.status).toBe(200);
    const ids = (res.body.leads as Array<{ id: string }>).map((l) => l.id);
    expect(ids).not.toContain(repALeadId);
  });

  it('forbids a SALES_REP from updating another rep\'s lead', async () => {
    const res = await request(app)
      .put(`/api/leads/${repALeadId}`)
      .set('Authorization', `Bearer ${repB.token}`)
      .send({ status: 'WON' });
    expect(res.status).toBe(404);
  });

  it('forbids a SALES_REP from deleting another rep\'s lead', async () => {
    const res = await request(app)
      .delete(`/api/leads/${repALeadId}`)
      .set('Authorization', `Bearer ${repB.token}`);
    expect(res.status).toBe(404);

    // The lead must still exist for its real owner.
    const stillThere = await request(app)
      .get(`/api/leads/${repALeadId}`)
      .set('Authorization', `Bearer ${repA.token}`);
    expect(stillThere.status).toBe(200);
  });

  it('allows ADMIN to read every lead in the tenant', async () => {
    const res = await request(app)
      .get('/api/leads')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    const ids = (res.body.leads as Array<{ id: string }>).map((l) => l.id);
    expect(ids).toContain(repALeadId);
  });
});

describe('Lead routing: cross-tenant isolation (RLS)', () => {
  it('prevents one tenant from reading another tenant\'s leads', async () => {
    const tenant1 = await registerTenant();
    const tenant2 = await registerTenant();

    const lead1 = await createLead(tenant1.token, 'Tenant1Lead');

    // tenant2 admin has viewAll within its own tenant, but RLS scopes rows to
    // tenant2 — so tenant1's lead is invisible even by direct id lookup.
    const byId = await request(app)
      .get(`/api/leads/${lead1}`)
      .set('Authorization', `Bearer ${tenant2.token}`);
    expect(byId.status).toBe(404);

    const list = await request(app)
      .get('/api/leads')
      .set('Authorization', `Bearer ${tenant2.token}`);
    expect(list.status).toBe(200);
    const ids = (list.body.leads as Array<{ id: string }>).map((l) => l.id);
    expect(ids).not.toContain(lead1);
  });
});

describe('Auth guards', () => {
  it('rejects unauthenticated access to leads', async () => {
    const res = await request(app).get('/api/leads');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid bearer token', async () => {
    const res = await request(app)
      .get('/api/leads')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });
});
