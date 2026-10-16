// Applies a .sql file to a database as the OWNER role, over the DIRECT (non-pooled) URL.
//   node scripts/db-apply-sql.mjs prisma/sql/runtime-role.sql          -> DIRECT_URL (dev)
//   node scripts/db-apply-sql.mjs prisma/sql/runtime-role.sql --test   -> TEST_DIRECT_URL
// Used for prisma/sql/runtime-role.sql, which must be re-applied after every migration that adds
// tables (it is idempotent). Prints no connection string.
import 'dotenv/config';
import dns from 'node:dns';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import pg from 'pg';

// same network settings as the app (see src/common/http/network.ts)
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/db-apply-sql.mjs <file.sql> [--test]');
  process.exit(2);
}
const variable = flag === '--test' ? 'TEST_DIRECT_URL' : 'DIRECT_URL';
const connectionString = process.env[variable];
if (!connectionString) {
  console.error(`${variable} is not set`);
  process.exit(2);
}
if (flag !== '--test' && /-pooler/.test(new URL(connectionString).hostname)) {
  console.error('DIRECT_URL points at the POOLED host; use the direct (non-pooler) host for DDL');
  process.exit(2);
}

const client = new pg.Client({ connectionString, connectionTimeoutMillis: 60_000 });
await client.connect();
try {
  await client.query(await readFile(file, 'utf8'));
  const db = (await client.query('SELECT current_database() AS db')).rows[0].db;
  console.log(`applied ${file} to database "${db}" (${variable})`);
} finally {
  await client.end();
}
