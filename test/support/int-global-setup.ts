import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { configureNetwork } from '../../src/common/http/network.js';
import { assertSafeTestDatabase } from './test-database.js';

const ATTEMPTS = 4;
const RETRY_DELAY_MS = 4_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Applies every migration to the test database as the owner role (direct URL), retrying cold starts. */
async function migrate(directUrl: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DIRECT_URL: directUrl },
      encoding: 'utf8',
      shell: true, // npx is npx.cmd on Windows
    });
    if (result.status === 0) return;
    if (attempt >= ATTEMPTS) {
      // Prisma's output can echo the host but not the password; the URL itself is never printed here.
      throw new Error(
        `prisma migrate deploy failed on the test database:\n${result.stdout}\n${result.stderr}`,
      );
    }
    await sleep(RETRY_DELAY_MS);
  }
}

/**
 * Re-applies the runtime role's grants (prisma/sql/runtime-role.sql, idempotent) after the migrations,
 * so a table added by a new migration is never left without them. The role itself (`fca_app`) must
 * exist: it is created once per Neon project (docs/neon-setup.md).
 */
async function grantRuntimeRole(directUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: directUrl });
  await client.connect();
  try {
    await client.query(
      await readFile(new URL('../../prisma/sql/runtime-role.sql', import.meta.url), 'utf8'),
    );
  } catch (error) {
    throw new Error(
      `Could not apply prisma/sql/runtime-role.sql to the test database: ${(error as Error).message}\n` +
        'Create the login role fca_app first (docs/neon-setup.md, "Runtime role").',
    );
  } finally {
    await client.end();
  }
}

/** Reference data seeded by the migrations (catalogues, not test data): never emptied. */
const REFERENCE_TABLES = new Set([
  'frameworks',
  'plans',
  'framework_versions',
  'requirements',
  'mapping_pack_entries',
  'assessment_templates',
  'assessment_template_items',
]);

/** Empties every table (as the owner) so each run starts clean. Tests still create their own organisations. */
async function reset(directUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: directUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`,
    );
    const emptied = rows.filter((row) => !REFERENCE_TABLES.has(row.table_name));
    if (emptied.length > 0) {
      const tables = emptied.map((row) => `"${row.table_name}"`).join(', ');
      await client.query(`TRUNCATE TABLE ${tables} CASCADE`);
    }
  } finally {
    await client.end();
  }
}

export default async function setup(): Promise<void> {
  // this process opens the owner connections (migrate, grants, reset): same network settings as the app
  configureNetwork('ipv4first', 2000);
  const database = assertSafeTestDatabase(process.env);
  await migrate(database.directUrl);
  await grantRuntimeRole(database.directUrl);
  await reset(database.directUrl);
}
