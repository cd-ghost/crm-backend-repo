import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { createApp } from '../src/app';
import { closePool } from '../src/config/pool';

const app = createApp();

/** Build an .xlsx buffer from an array-of-arrays (first row = header). */
function xlsxBuffer(aoa: unknown[][]): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function csvBuffer(aoa: unknown[][]): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  return Buffer.from(XLSX.utils.sheet_to_csv(sheet), 'utf8');
}

const HEADER = ['Opportunity Name', 'Account Name', 'Stage', 'Estimated Revenue'];

async function registerTenant(): Promise<{ token: string; tenantId: string; userId: string }> {
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
    userId: res.body.user.id as string,
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
  return { token: login.body.token as string, userId: created.body.user.id as string };
}

afterAll(async () => {
  await closePool();
});

describe('POST /api/opportunities/import', () => {
  let tenant: { token: string; tenantId: string; userId: string };

  beforeAll(async () => {
    tenant = await registerTenant();
  });

  it('imports all valid rows and injects tenant_id/owner_id from the JWT', async () => {
    const buf = xlsxBuffer([
      HEADER,
      ['Acme Expansion', 'Acme Corp', 'PROSPECTING', 25000],
      ['Globex Renewal', 'Globex', 'NEGOTIATION', '$12,500.50'],
    ]);

    const res = await request(app)
      .post('/api/opportunities/import')
      .set('Authorization', `Bearer ${tenant.token}`)
      .attach('file', buf, 'opps.xlsx');

    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(2);
    expect(res.body.ids).toHaveLength(2);

    const list = await request(app)
      .get('/api/opportunities')
      .set('Authorization', `Bearer ${tenant.token}`);
    expect(list.status).toBe(200);
    const names = (list.body.opportunities as Array<Record<string, unknown>>).map((o) => o.name);
    expect(names).toContain('Acme Expansion');
    expect(names).toContain('Globex Renewal');
    for (const opp of list.body.opportunities as Array<Record<string, unknown>>) {
      expect(opp.tenant_id).toBe(tenant.tenantId);
      expect(opp.owner_id).toBe(tenant.userId);
    }
    // "$12,500.50" was normalized to a numeric value.
    const globex = (list.body.opportunities as Array<Record<string, unknown>>).find(
      (o) => o.name === 'Globex Renewal',
    );
    expect(Number(globex!.estimated_revenue)).toBeCloseTo(12500.5, 2);
  });

  it('aborts the entire import and reports the exact failing row/cell', async () => {
    const before = await request(app)
      .get('/api/opportunities')
      .set('Authorization', `Bearer ${tenant.token}`);
    const beforeCount = (before.body.opportunities as unknown[]).length;

    const buf = xlsxBuffer([
      HEADER,
      ['Valid One', 'Account A', 'PROSPECTING', 1000], // row 2 - ok
      ['Missing Account', '', 'PROSPECTING', 2000], // row 3 - blank Account Name
      ['Bad Revenue', 'Account C', 'PROPOSAL', 'not-a-number'], // row 4 - bad revenue
    ]);

    const res = await request(app)
      .post('/api/opportunities/import')
      .set('Authorization', `Bearer ${tenant.token}`)
      .attach('file', buf, 'bad.xlsx');

    expect(res.status).toBe(422);
    expect(res.body.imported).toBe(0);
    const errors = res.body.errors as Array<{ row: number; column: string }>;
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 3, column: 'Account Name' }),
        expect.objectContaining({ row: 4, column: 'Estimated Revenue' }),
      ]),
    );

    // Nothing should have been written (full-transaction abort).
    const after = await request(app)
      .get('/api/opportunities')
      .set('Authorization', `Bearer ${tenant.token}`);
    expect((after.body.opportunities as unknown[]).length).toBe(beforeCount);
  });

  it('rejects a file missing a mandatory column', async () => {
    const buf = xlsxBuffer([
      ['Opportunity Name', 'Account Name', 'Estimated Revenue'], // no Stage
      ['No Stage', 'Account', 5000],
    ]);
    const res = await request(app)
      .post('/api/opportunities/import')
      .set('Authorization', `Bearer ${tenant.token}`)
      .attach('file', buf, 'nostage.xlsx');

    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ column: 'Stage' })]),
    );
  });

  it('accepts CSV uploads', async () => {
    const buf = csvBuffer([HEADER, ['CSV Opp', 'CSV Account', 'PROPOSAL', 999]]);
    const res = await request(app)
      .post('/api/opportunities/import')
      .set('Authorization', `Bearer ${tenant.token}`)
      .attach('file', buf, 'opps.csv');
    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(1);
  });

  it('rejects unauthenticated imports', async () => {
    const buf = xlsxBuffer([HEADER, ['X', 'Y', 'Z', 1]]);
    const res = await request(app).post('/api/opportunities/import').attach('file', buf, 'x.xlsx');
    expect(res.status).toBe(401);
  });

  it('returns 400 when no file is attached', async () => {
    const res = await request(app)
      .post('/api/opportunities/import')
      .set('Authorization', `Bearer ${tenant.token}`);
    expect(res.status).toBe(400);
  });

  it('rejects unsupported file types', async () => {
    const res = await request(app)
      .post('/api/opportunities/import')
      .set('Authorization', `Bearer ${tenant.token}`)
      .attach('file', Buffer.from('hello'), 'notes.txt');
    expect(res.status).toBe(400);
  });
});

describe('Opportunity import: tenant + owner isolation', () => {
  it('keeps imported rows invisible to other tenants and other reps', async () => {
    const tenantA = await registerTenant();
    const repA = await createRep(tenantA.token);
    const repB = await createRep(tenantA.token);
    const tenantB = await registerTenant();

    const buf = xlsxBuffer([HEADER, ['Secret Deal', 'Secret Account', 'PROSPECTING', 77000]]);
    const imp = await request(app)
      .post('/api/opportunities/import')
      .set('Authorization', `Bearer ${repA.token}`)
      .attach('file', buf, 'secret.xlsx');
    expect(imp.status).toBe(201);

    // Another rep in the same tenant (owner-scoped) cannot see repA's rows.
    const repBList = await request(app)
      .get('/api/opportunities')
      .set('Authorization', `Bearer ${repB.token}`);
    expect((repBList.body.opportunities as Array<{ name: string }>).map((o) => o.name)).not.toContain(
      'Secret Deal',
    );

    // ADMIN of tenant A sees it (viewAll within tenant).
    const adminList = await request(app)
      .get('/api/opportunities')
      .set('Authorization', `Bearer ${tenantA.token}`);
    expect((adminList.body.opportunities as Array<{ name: string }>).map((o) => o.name)).toContain(
      'Secret Deal',
    );

    // A different tenant cannot see it at all (RLS).
    const tenantBList = await request(app)
      .get('/api/opportunities')
      .set('Authorization', `Bearer ${tenantB.token}`);
    expect((tenantBList.body.opportunities as Array<{ name: string }>).map((o) => o.name)).not.toContain(
      'Secret Deal',
    );
  });
});
