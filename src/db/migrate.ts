import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Apply every SQL file in /migrations in lexical order.
 *
 * Migrations create the `crm_app` role, tables, RLS policies and grants, so
 * they must run as a superuser/owner — NOT as the restricted application role.
 * Provide that connection via MIGRATION_DATABASE_URL (falls back to
 * DATABASE_URL for simple local setups where they are the same).
 */
async function main(): Promise<void> {
  const connectionString =
    process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('Set MIGRATION_DATABASE_URL or DATABASE_URL to run migrations');
  }

  const migrationsDir = join(__dirname, '..', '..', 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const file of files) {
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      // eslint-disable-next-line no-console
      console.log(`Applying migration: ${file}`);
      await client.query(sql);
    }
    // eslint-disable-next-line no-console
    console.log(`Applied ${files.length} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Migration failed:', err);
  process.exit(1);
});
