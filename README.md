# Multi-Tenant CRM Backend

A secure, enterprise-style CRM API backend. Tenant isolation is enforced at the
**database layer** with PostgreSQL Row-Level Security (RLS), not merely in
application code — so a forgotten `WHERE tenant_id = ...` cannot leak data
across tenants.

## Stack

- **Node.js + strict TypeScript** (`tsconfig` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, …)
- **Express.js** with modular routers and standard middleware
- **PostgreSQL** via the raw [`pg`](https://node-postgres.com/) pool driver — **no ORM**
- **bcrypt** password hashing, **stateless JWT** auth
- **Vitest + supertest** integration tests

## Architecture

```
src/
  config/      env loading + pg Pool (connects as the restricted app role)
  db/          executeTenantQuery / withTenantTransaction (RLS context), migrate runner
  auth/        password hashing + JWT sign/verify
  middleware/  authenticateJWT, injectAccessScope (RBAC), requireRole, error handling
  routes/      auth, users, leads, deals
  types/       roles, entities, AuthUser, AccessScope, Express augmentation
  domain/      runtime enum arrays
migrations/    001_init.sql — schema, RLS policies, app role + grants
tests/         SALES_REP isolation, cross-tenant RLS, deals isolation, auth guards
```

## Security model

### Tenant isolation (RLS)
`leads` and `deals` have `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL
SECURITY`, with policies that match rows against a transaction-local GUC:

```sql
USING (tenant_id = current_tenant_id())
WITH CHECK (tenant_id = current_tenant_id())
```

The API **must** connect as the dedicated `crm_app` role
(`NOSUPERUSER NOBYPASSRLS`). Superusers and `BYPASSRLS` roles ignore RLS, so
this separation is what makes the policies enforceable. Every tenant-scoped
query runs through `executeTenantQuery`, which:

1. acquires a pooled client,
2. `BEGIN`,
3. binds `app.current_tenant_id` with `set_config(..., is_local => true)` — the
   parameterized, injection-safe equivalent of
   `SET LOCAL app.current_tenant_id = <tenant_id>`,
4. runs the query,
5. `COMMIT` + release (or `ROLLBACK` + release on any error).

Because the setting is transaction-local, it can never leak to another request
that later reuses the same pooled connection.

### Role-based access control
`injectAccessScope` sets `req.accessScope` from the JWT role:

| Role        | `viewAll` | `restrictToOwner` |
|-------------|-----------|-------------------|
| `ADMIN`     | true      | false             |
| `MANAGER`   | true      | false             |
| `SALES_REP` | false     | true              |

When `restrictToOwner` is true, lead/deal queries append `WHERE owner_id = $n`
(scoped to the JWT `userId`), so a SALES_REP can only read/update/delete records
it owns. This is layered on top of RLS (tenant) for defense in depth.

## API

| Method | Path                  | Auth        | Notes                                  |
|--------|-----------------------|-------------|----------------------------------------|
| POST   | `/api/auth/register`  | public      | Creates a tenant + its first ADMIN     |
| POST   | `/api/auth/login`     | public      | Returns a JWT                          |
| GET    | `/api/users`          | ADMIN/MGR   | List users in tenant                   |
| POST   | `/api/users`          | ADMIN       | Provision a user in tenant             |
| GET/POST/PUT/DELETE | `/api/leads`[ /:id ] | any role | owner-scoped for SALES_REP        |
| GET/POST/PUT/DELETE | `/api/deals`[ /:id ] | any role | owner-scoped for SALES_REP        |
| GET/POST/PUT/DELETE | `/api/opportunities`[ /:id ] | any role | owner-scoped for SALES_REP   |
| POST   | `/api/opportunities/import`  | any role | bulk import from .xlsx/.csv       |

JWT payload: `{ userId, tenantId, role }`.

## Bulk import engine

`POST /api/opportunities/import` accepts a multipart upload (field `file`,
`.xlsx` or `.csv`). It:

1. parses the sheet with `xlsx` into a structured array;
2. validates the mandatory columns — `Opportunity Name`, `Account Name`,
   `Stage`, `Estimated Revenue` — and every cell (revenue must be numeric;
   `$1,250.50` style formatting is tolerated);
3. on **any** failure, aborts the whole import and returns `422` with a targeted
   error report (`{ row, column, value, message }`) — nothing is written;
4. injects the caller's `tenant_id` / `owner_id` from the JWT into every row;
5. performs a single set-based `unnest(...)` bulk insert **inside
   `executeTenantQuery`**, so the entire batch runs in one RLS-scoped
   transaction and rolls back atomically on error.

## Setup

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL / MIGRATION_DATABASE_URL / JWT_SECRET
npm run migrate             # creates crm_app role, tables, RLS, grants
npm run build               # strict tsc compile
npm test                    # integration tests (needs a reachable Postgres)
npm run dev                 # start the API
```

`DATABASE_URL` must point at the **`crm_app`** role; `MIGRATION_DATABASE_URL`
must point at a superuser/owner (migrations create roles and policies).

### Local Postgres (Docker)

```bash
docker run -d --name crm-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=crm \
  -p 5432:5432 postgres:16
```

## Tests

The suite proves the core security guarantee — a `SALES_REP` token **cannot**
read, update, or delete leads/deals owned by a different `owner_id`, and one
tenant cannot see another tenant's rows even via a raw unfiltered `SELECT`
(RLS), nor insert rows for a foreign tenant (RLS `WITH CHECK`).
