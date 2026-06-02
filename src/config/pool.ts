import { Pool } from 'pg';
import { config } from './env';

/**
 * Shared pg connection pool. The pool connects as the dedicated, non-superuser
 * application role so that PostgreSQL Row-Level Security policies are enforced
 * (superusers and BYPASSRLS roles ignore RLS).
 */
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err: Error) => {
  // A pooled client may emit an error while idle; log so it is not swallowed.
  // eslint-disable-next-line no-console
  console.error('Unexpected error on idle pg client', err);
});

export async function closePool(): Promise<void> {
  await pool.end();
}
