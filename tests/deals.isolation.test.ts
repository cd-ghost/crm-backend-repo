import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app';
import { closePool } from '../src/config/pool';

const app = createApp();

async function registerTenant(): Promise<{ token: string }> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({
      companyName: `Co-${randomUUID()}`,
      email: `admin-${randomUUID()}@example.com`,
      password: 'Sup3rSecret!',
    });
  expect(res.status).toBe(201);
  return { token: res.body.token as string };
}

async function createRep(adminToken: string): Promise<string> {
  const email = `rep-${randomUUID()}@example.com`;
  const password = 'R3pPassword!';
  const created = await request(app)
    .post('/api/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email, password, role: 'SALES_REP' });
  expect(created.status).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  return login.body.token as string;
}

afterAll(async () => {
  await closePool();
});

describe('Deal routing: SALES_REP owner isolation', () => {
  let adminToken: string;
  let repAToken: string;
  let repBToken: string;
  let dealId: string;

  beforeAll(async () => {
    const admin = await registerTenant();
    adminToken = admin.token;
    repAToken = await createRep(adminToken);
    repBToken = await createRep(adminToken);

    const lead = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${repAToken}`)
      .send({ first_name: 'Deal', last_name: 'Owner' });
    expect(lead.status).toBe(201);

    const deal = await request(app)
      .post('/api/deals')
      .set('Authorization', `Bearer ${repAToken}`)
      .send({ lead_id: lead.body.lead.id, amount: 5000, stage: 'PROSPECTING' });
    expect(deal.status).toBe(201);
    dealId = deal.body.deal.id as string;
  });

  it('forbids a SALES_REP from reading another rep\'s deal', async () => {
    const res = await request(app)
      .get(`/api/deals/${dealId}`)
      .set('Authorization', `Bearer ${repBToken}`);
    expect(res.status).toBe(404);
  });

  it('excludes other reps\' deals from a SALES_REP list query', async () => {
    const res = await request(app)
      .get('/api/deals')
      .set('Authorization', `Bearer ${repBToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body.deals as Array<{ id: string }>).map((d) => d.id);
    expect(ids).not.toContain(dealId);
  });

  it('allows ADMIN to read every deal in the tenant', async () => {
    const res = await request(app)
      .get('/api/deals')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body.deals as Array<{ id: string }>).map((d) => d.id);
    expect(ids).toContain(dealId);
  });
});
