// Creates (or refreshes) a TEST COMPANY in the DEV database so the app can be tried by hand:
// one organisation with a demo account for each of the six roles, a deactivated member, a pending
// invitation, company settings, business units, governance areas, a regulator contact, applicable frameworks and a plan. Safe to run again: everything has a fixed id and is upserted.
//
//   npm run seed:dev                                  (DIRECT_URL = the dev database, direct host)
//   npm run seed:dev -- --owner you@example.com       (also makes your own registered account an Owner)
//
// DEVELOPMENT ONLY: the demo accounts share a published password. The script refuses to run when
// NODE_ENV=production or when the database name looks like a test database (those are emptied by
// the integration tests anyway). Uses the OWNER credentials over the DIRECT url; prints no connection string.
import 'dotenv/config';
import dns from 'node:dns';
import net from 'node:net';
import { hash } from '@node-rs/argon2';
import pg from 'pg';

// same network settings as the app (see src/common/http/network.ts)
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

const DEMO_PASSWORD = 'demo-company-passphrase-2026';
const DOMAIN = 'demo.example.test';

/** Fixed ids make the seed idempotent. UUIDv7-shaped, with a recognisable prefix. */
const id = (n) => `01990000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ORGANISATION = {
  id: id(1),
  name: 'Demo Company (test)',
  timezone: 'Africa/Harare',
};
const PEOPLE = [
  { n: 10, local: 'owner', fullName: 'Olivia Owner', role: 'COMPANY_OWNER', status: 'ACTIVE' },
  { n: 11, local: 'admin', fullName: 'Adam Admin', role: 'COMPANY_ADMIN', status: 'ACTIVE' },
  {
    n: 12,
    local: 'manager',
    fullName: 'Mona Manager',
    role: 'COMPLIANCE_MANAGER',
    status: 'ACTIVE',
  },
  {
    n: 13,
    local: 'courses',
    fullName: 'Chris Courses',
    role: 'COURSE_ADMINISTRATOR',
    status: 'ACTIVE',
  },
  { n: 14, local: 'standard', fullName: 'Sam Standard', role: 'STANDARD_USER', status: 'ACTIVE' },
  { n: 15, local: 'readonly', fullName: 'Rita Readonly', role: 'READ_ONLY', status: 'ACTIVE' },
  {
    n: 16,
    local: 'former',
    fullName: 'Frank Former',
    role: 'STANDARD_USER',
    status: 'DEACTIVATED',
  },
];

const args = process.argv.slice(2);
const ownerIndex = args.indexOf('--owner');
const ownEmail = ownerIndex >= 0 ? args[ownerIndex + 1]?.trim().toLowerCase() : undefined;
if (ownerIndex >= 0 && !ownEmail) {
  console.error('usage: node scripts/seed-dev.mjs [--owner <your registered email>]');
  process.exit(2);
}

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo accounts when NODE_ENV=production.');
  process.exit(2);
}
const connectionString = process.env.DIRECT_URL;
if (!connectionString) {
  console.error('DIRECT_URL is not set (the DIRECT host of the dev database).');
  process.exit(2);
}
const url = new URL(connectionString);
if (/-pooler/.test(url.hostname)) {
  console.error('DIRECT_URL points at the POOLED host; use the direct (non-pooler) host.');
  process.exit(2);
}
if (/test/i.test(url.pathname)) {
  console.error('Refusing: this looks like a test database. Seed the dev database.');
  process.exit(2);
}

const passwordHash = await hash(DEMO_PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
const client = new pg.Client({ connectionString, connectionTimeoutMillis: 60_000 });
await client.connect();
try {
  await client.query('BEGIN');

  await client.query(
    `INSERT INTO organisations (id, name, timezone, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, timezone = EXCLUDED.timezone, updated_at = now()`,
    [ORGANISATION.id, ORGANISATION.name, ORGANISATION.timezone],
  );

  for (const person of PEOPLE) {
    const email = `${person.local}@${DOMAIN}`;
    await client.query(
      `INSERT INTO users (id, email, full_name, password_hash, email_verified_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (id) DO UPDATE
         SET full_name = EXCLUDED.full_name, password_hash = EXCLUDED.password_hash,
             email_verified_at = COALESCE(users.email_verified_at, now()), is_active = true, updated_at = now()`,
      [id(person.n), email, person.fullName, passwordHash],
    );
    await client.query(
      `INSERT INTO memberships (id, organisation_id, user_id, role, status, updated_at)
       VALUES ($1, $2, $3, $4::membership_role, $5::membership_status, now())
       ON CONFLICT (organisation_id, user_id) DO UPDATE
         SET role = EXCLUDED.role, status = EXCLUDED.status, updated_at = now()`,
      [id(person.n + 100), ORGANISATION.id, id(person.n), person.role, person.status],
    );
  }

  // one open invitation so the Invitations table has something to show (it has not been emailed yet)
  await client.query(
    `INSERT INTO invitations (id, organisation_id, email, role, status, expires_at, invited_by_user_id, updated_at)
     VALUES ($1, $2, $3, 'COMPLIANCE_MANAGER', 'PENDING', now() + interval '7 days', $4, now())
     ON CONFLICT (id) DO UPDATE SET expires_at = now() + interval '7 days', updated_at = now()
     WHERE invitations.status = 'PENDING'`,
    [id(200), ORGANISATION.id, `invitee@${DOMAIN}`, id(10)],
  );

  // a first audit event, only when none exists yet (the trail is append-only)
  await client.query(
    `INSERT INTO audit_events (id, organisation_id, actor_type, actor_user_id, action, entity_type, entity_id, entity_label)
     SELECT $1::uuid, $2::uuid, 'USER', $3::uuid, 'organisation.created', 'organisation', $4, $5
     WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE id = $1::uuid)`,
    [id(300), ORGANISATION.id, id(10), ORGANISATION.id, ORGANISATION.name],
  );

  // ---- Phase 3 data: company settings, business units, a regulator contact, frameworks and a plan
  await client.query(
    `UPDATE organisations SET display_name = 'Demo Company', legal_name = 'Demo Company Ltd',
       registration_number = 'DEMO-0001', sector = 'Professional services', country = 'Zimbabwe', address = '1 Example Street, Harare',
       dpo_name = 'Dee Protection', dpo_email = 'dpo@${DOMAIN}', dpo_phone = '+263 77 000 0000', updated_at = now()
     WHERE id = $1`,
    [ORGANISATION.id],
  );

  // business units: head = a member (membership id), sensitivity 1 (Public) to 5 (Critical), employees, optional parent.
  // Parents come first so the composite foreign key finds them.
  const units = [
    {
      n: 400,
      name: 'Finance',
      code: 'FIN',
      description: 'Accounts, payroll and procurement',
      head: 112,
      sensitivity: 4,
      employees: 12,
      parent: null,
      archived: false,
    },
    {
      n: 401,
      name: 'Human Resources',
      code: 'HR',
      description: 'People records and recruitment',
      head: 111,
      sensitivity: 5,
      employees: 6,
      parent: null,
      archived: false,
    },
    {
      n: 402,
      name: 'IT & Security',
      code: 'IT',
      description: 'Systems, access and incident response',
      head: 110,
      sensitivity: 4,
      employees: 8,
      parent: null,
      archived: false,
    },
    {
      n: 403,
      name: 'Operations',
      code: 'OPS',
      description: null,
      head: null,
      sensitivity: 2,
      employees: 40,
      parent: null,
      archived: false,
    },
    {
      n: 405,
      name: 'Payroll',
      code: 'PAY',
      description: 'A sub-unit of Finance',
      head: null,
      sensitivity: 5,
      employees: 3,
      parent: 400,
      archived: false,
    },
    {
      n: 404,
      name: 'Legacy Unit',
      code: 'OLD',
      description: 'Archived on purpose, to show history',
      head: null,
      sensitivity: null,
      employees: null,
      parent: null,
      archived: true,
    },
  ];
  for (const unit of units) {
    await client.query(
      `INSERT INTO business_units (id, organisation_id, name, code, description, head_membership_id, sensitivity,
                                   employee_count, parent_id, archived_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::uuid, $7, $8, $9::uuid, CASE WHEN $10::boolean THEN now() ELSE NULL END, now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, code = EXCLUDED.code, description = EXCLUDED.description,
         head_membership_id = EXCLUDED.head_membership_id, sensitivity = EXCLUDED.sensitivity,
         employee_count = EXCLUDED.employee_count, parent_id = EXCLUDED.parent_id,
         archived_at = EXCLUDED.archived_at, updated_at = now()`,
      [
        id(unit.n),
        ORGANISATION.id,
        unit.name,
        unit.code,
        unit.description,
        unit.head === null ? null : id(unit.head),
        unit.sensitivity,
        unit.employees,
        unit.parent === null ? null : id(unit.parent),
        unit.archived,
      ],
    );
  }

  // ---- Phase 4 data: governance areas, the organisation's own topics for the compliance mapping table. They
  // are plain labels (no legal content). Mappings are NOT seeded: they need verified framework content, which
  // is loaded with `npm run frameworks:verify` and `npm run frameworks:load`.
  const areas = [
    [500, 'Lawful basis and consent', 'Why personal data is processed and how consent is handled'],
    [501, 'Data subject rights', 'Access, correction, erasure and the other rights of individuals'],
    [502, 'Breach notification', 'Detecting, assessing and reporting personal data breaches'],
    [503, 'Security measures', 'Technical and organisational protection of personal data'],
    [504, 'Records of processing', 'Keeping a record of what is processed, why and by whom'],
    [505, 'Third parties and transfers', 'Processors, suppliers and moving data across borders'],
  ];
  for (const [n, name, description] of areas) {
    await client.query(
      `INSERT INTO governance_areas (id, organisation_id, name, description, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = now()`,
      [id(n), ORGANISATION.id, name, description],
    );
  }

  await client.query(
    `INSERT INTO regulator_contacts (id, organisation_id, authority_name, jurisdiction, contact_name, email, phone, notes, updated_at)
     VALUES ($1, $2, 'Example Data Protection Authority', 'Zimbabwe', 'Regulator Liaison', 'liaison@regulator.${DOMAIN}',
             '+263 77 000 1111', 'Fictional contact for testing: replace with your real regulator.', now())
     ON CONFLICT (id) DO UPDATE SET updated_at = now()`,
    [id(450), ORGANISATION.id],
  );

  // applicable frameworks: CDPA and GDPR active, ISO 27701 declared and later removed (history is kept)
  const selections = [
    { n: 500, code: 'CDPA', removed: false },
    { n: 501, code: 'GDPR', removed: false },
    { n: 502, code: 'ISO 27701', removed: true },
  ];
  for (const selection of selections) {
    await client.query(
      `INSERT INTO organisation_frameworks (id, organisation_id, framework_id, removed_at, updated_at)
       SELECT $1::uuid, $2::uuid, f.id, CASE WHEN $4::boolean THEN now() ELSE NULL END, now()
       FROM frameworks f WHERE f.code = $3
       ON CONFLICT (organisation_id, framework_id) DO NOTHING`,
      [id(selection.n), ORGANISATION.id, selection.code, selection.removed],
    );
  }

  // the Professional plan (placeholder limits: 25 users)
  await client.query(
    `INSERT INTO organisation_entitlements (id, organisation_id, plan_id, plan_code, plan_name, max_users, api_access, assigned_by_user_id, updated_at)
     SELECT $1::uuid, $2::uuid, p.id, p.code, p.name, p.max_users, p.api_access, $3::uuid, now()
     FROM plans p WHERE p.code = 'professional'
     ON CONFLICT (organisation_id) DO NOTHING`,
    [id(550), ORGANISATION.id, id(10)],
  );

  let attached = '';
  if (ownEmail) {
    const found = await client.query('SELECT id, is_active FROM users WHERE email = $1', [
      ownEmail,
    ]);
    if (found.rowCount === 0) {
      attached = `\nNo account with ${ownEmail} exists yet: register and confirm it first, then run this again with --owner.`;
    } else {
      await client.query(
        `INSERT INTO memberships (id, organisation_id, user_id, role, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'COMPANY_OWNER', 'ACTIVE', now())
         ON CONFLICT (organisation_id, user_id) DO UPDATE
           SET role = 'COMPANY_OWNER', status = 'ACTIVE', updated_at = now()`,
        [ORGANISATION.id, found.rows[0].id],
      );
      attached = `\n${ownEmail} is now a Company Owner of "${ORGANISATION.name}".`;
    }
  }

  await client.query('COMMIT');
  const db = (await client.query('SELECT current_database() AS db')).rows[0].db;
  console.log(`Seeded "${ORGANISATION.name}" in database "${db}".${attached}`);
  console.log(`\nSign in at the web app with any of these accounts (same password for all):`);
  for (const person of PEOPLE.filter((p) => p.status === 'ACTIVE')) {
    console.log(`  ${`${person.local}@${DOMAIN}`.padEnd(32)} ${person.role}`);
  }
  console.log(`  password: ${DEMO_PASSWORD}`);
  console.log(
    `  (frank.former is a deactivated member; invitee@${DOMAIN} has a pending invitation)`,
  );
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
