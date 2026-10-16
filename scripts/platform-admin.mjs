// Grants or revokes the PLATFORM ADMINISTRATOR flag of a user (ADR-0005), over the DIRECT database URL
// with the OWNER credentials. There is deliberately no API for this: nobody can make themselves (or
// anyone else) a platform administrator through the application.
//
//   npm run platform-admin -- grant you@example.com
//   npm run platform-admin -- revoke you@example.com
//   npm run platform-admin -- grant you@example.com --test     (uses TEST_DIRECT_URL)
//
// The change and its security event are written in one transaction. Prints no connection string.
import 'dotenv/config';
import dns from 'node:dns';
import net from 'node:net';
import pg from 'pg';

// same network settings as the app (see src/common/http/network.ts)
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

const args = process.argv.slice(2);
const test = args.includes('--test');
const [action, rawEmail] = args.filter((arg) => !arg.startsWith('--'));
if (!['grant', 'revoke'].includes(action ?? '') || !rawEmail) {
  console.error('usage: node scripts/platform-admin.mjs <grant|revoke> <email> [--test]');
  process.exit(2);
}
const email = rawEmail.trim().toLowerCase();

const variable = test ? 'TEST_DIRECT_URL' : 'DIRECT_URL';
const connectionString = process.env[variable];
if (!connectionString) {
  console.error(`${variable} is not set`);
  process.exit(2);
}
if (/-pooler/.test(new URL(connectionString).hostname)) {
  console.error(`${variable} points at the POOLED host; use the direct (non-pooler) host`);
  process.exit(2);
}

const grant = action === 'grant';
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 60_000 });
await client.connect();
try {
  await client.query('BEGIN');
  const updated = await client.query(
    `UPDATE users SET is_platform_admin = $1, updated_at = now()
     WHERE email = $2 AND is_active AND is_platform_admin IS DISTINCT FROM $1
     RETURNING id`,
    [grant, email],
  );
  if (updated.rowCount === 0) {
    const existing = await client.query(
      'SELECT is_active, is_platform_admin FROM users WHERE email = $1',
      [email],
    );
    await client.query('ROLLBACK');
    if (existing.rowCount === 0) {
      console.error('No user has that email address (they must register first).');
      process.exitCode = 1;
    } else if (!existing.rows[0].is_active) {
      console.error('That user is deactivated.');
      process.exitCode = 1;
    } else {
      console.log(
        `Nothing to do: the user is already ${grant ? '' : 'not '}a platform administrator.`,
      );
    }
  } else {
    await client.query(
      `INSERT INTO security_events (id, event_type, outcome, user_id, metadata)
       VALUES (gen_random_uuid(), $1, 'SUCCESS', $2, $3::jsonb)`,
      [
        grant ? 'platform_admin.granted' : 'platform_admin.revoked',
        updated.rows[0].id,
        JSON.stringify({ via: 'platform-admin script' }),
      ],
    );
    await client.query('COMMIT');
    const db = (await client.query('SELECT current_database() AS db')).rows[0].db;
    console.log(
      `${grant ? 'Granted' : 'Revoked'} the platform administrator flag for ${email} in database "${db}".`,
    );
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
