// Framework content packs: extract from a primary source, verify by a named person, load into the database.
//
//   npm run frameworks:status
//   npm run frameworks:extract -- nist|gdpr [--refresh]     parse the stored source (--refresh downloads it first)
//   npm run frameworks:verify  -- <pack> --by "Full Name"   a PERSON states they compared the pack with the source
//   npm run frameworks:load    [-- <pack>...]               load every VERIFIED pack (owner credentials, DIRECT_URL)
//
// A pack is data under prisma/seed-data/<framework>/<version>/ (docs/frameworks/source-registry.md). The
// loader accepts only packs that are verified, whose content still matches the hash that was verified and
// whose stored source file is unchanged. A loaded version can never be changed again (database trigger).
import 'dotenv/config';
import dns from 'node:dns';
import net from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { extractGdpr } from './extract-gdpr.mjs';
import { extractNist } from './extract-nist.mjs';
import {
  PACKS_DIR,
  checkPack,
  contentHashOf,
  createUuidV7,
  listPackDirs,
  readPack,
  resolvePackDir,
  sha256,
  writePack,
} from './lib.mjs';

// same network settings as the app (see src/common/http/network.ts)
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

const SOURCES = {
  nist: {
    dir: 'nist-csf/2.0',
    framework: 'NIST CSF',
    label: 'NIST CSF 2.0',
    licenceClass: 'PUBLIC_DOMAIN',
    url: 'https://csrc.nist.gov/extensions/nudp/services/json/csf/download?olirids=all',
    headers: {},
    file: 'source.xlsx',
    citation:
      'NIST Cybersecurity Framework (CSF) 2.0 Core, as exported by the NIST CSF 2.0 Reference Tool (csrc.nist.gov). ' +
      'The export itself says it is a user-generated version of the Core and not the official publication: the ' +
      'verifier compares it with NIST CSWP 29, https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf.',
    extract: extractNist,
  },
  gdpr: {
    dir: 'gdpr/2016-679',
    framework: 'GDPR',
    label: 'GDPR (EU) 2016/679',
    licenceClass: 'OPEN_REUSE',
    url: 'https://publications.europa.eu/resource/celex/32016R0679',
    headers: { Accept: 'application/xhtml+xml', 'Accept-Language': 'en' },
    file: 'source.xhtml',
    citation:
      'Regulation (EU) 2016/679 of the European Parliament and of the Council of 27 April 2016 (General Data ' +
      'Protection Regulation), OJ L 119, 4.5.2016. English text as published by the EU Publications Office ' +
      '(CELEX 32016R0679); EU legal acts may be reused with attribution. Only identifiers and headings are stored.',
    extract: extractGdpr,
  },
};

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(`--${name}`);
const option = (name) => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : undefined;
};
const positional = rest.filter(
  (value, index) => !value.startsWith('--') && !rest[index - 1]?.startsWith('--by'),
);

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

// ------------------------------------------------------------------------------------------------ extract
async function extract(key) {
  const source = SOURCES[key];
  if (!source) fail(`Unknown source "${key}". Use one of: ${Object.keys(SOURCES).join(', ')}.`);
  const dir = path.join(PACKS_DIR, source.dir);
  const packFile = path.join(dir, 'pack.json');
  const existing = existsSync(packFile) ? readPack(dir) : null;
  const sourceFile = path.join(dir, source.file);

  let retrievedAt = existing?.version?.source?.retrievedAt;
  if (flag('refresh')) {
    console.log(`Downloading ${source.url} ...`);
    const response = await fetch(source.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (fca framework-pack tooling)', ...source.headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) fail(`The download failed: HTTP ${response.status}.`);
    const buffer = Buffer.from(await response.arrayBuffer());
    mkdirSync(dir, { recursive: true });
    writeFileSync(sourceFile, buffer);
    retrievedAt = new Date().toISOString();
    console.log(`Stored ${source.file} (${buffer.length} bytes).`);
  } else if (!existsSync(sourceFile)) {
    fail(
      `There is no stored source file at ${sourceFile}. Run once with --refresh to download it.`,
    );
  } else if (!retrievedAt) {
    fail('The stored source has no retrieval time; run with --refresh.');
  }

  const buffer = readFileSync(sourceFile);
  const result = source.extract(buffer);
  const pack = {
    schema: 1,
    framework: source.framework,
    version: {
      label: source.label,
      licenceClass: source.licenceClass,
      effectiveFrom: result.effectiveFrom ?? null,
      status: 'draft',
      source: {
        url: source.url,
        file: source.file,
        citation: source.citation,
        retrievedAt,
        sha256: sha256(buffer),
      },
      contentHash: '',
      verifiedBy: null,
      verifiedAt: null,
    },
    // how the content was derived (not part of the verified hash)
    extraction: {
      tool: `scripts/frameworks/extract-${key}.mjs`,
      counts: result.counts,
      ...(result.notes ? { notes: result.notes } : {}),
    },
    requirements: result.requirements,
    mappings: existing?.mappings ?? [],
  };
  pack.version.contentHash = contentHashOf(pack);

  if (existing?.version?.status === 'verified') {
    if (existing.version.contentHash === pack.version.contentHash) {
      console.log('The verified pack is unchanged by this extraction; nothing written.');
      return;
    }
    fail(
      'The extraction differs from the VERIFIED pack. A verified pack is never rewritten: create a new version instead.',
    );
  }
  writePack(dir, pack);
  console.log(
    `Wrote ${path.relative(process.cwd(), packFile)} as a DRAFT:`,
    JSON.stringify(result.counts),
  );
  console.log(
    'It is not loaded anywhere. A named person must compare it with the source, then run: npm run frameworks:verify',
  );
}

// ------------------------------------------------------------------------------------------------ verify
function verify(arg) {
  if (!arg)
    fail('usage: npm run frameworks:verify -- <pack, for example nist-csf/2.0> --by "Full Name"');
  const by = option('by')?.trim();
  if (!by || by.length < 2) fail('--by "Full Name" is required: the verifier is a named person.');
  const dir = resolvePackDir(arg);
  const pack = readPack(dir);
  if (pack.version.status === 'verified')
    fail(`Already verified by ${pack.version.verifiedBy} on ${pack.version.verifiedAt}.`);
  const problems = checkPack(pack, dir);
  if (problems.length > 0)
    fail(`The pack has problems and cannot be verified:\n - ${problems.join('\n - ')}`);

  pack.version.status = 'verified';
  pack.version.verifiedBy = by;
  pack.version.verifiedAt = new Date().toISOString();
  writePack(dir, pack);
  console.log(`Marked ${pack.version.label} as VERIFIED by ${by}.`);
  console.log(
    `By running this command you state that you compared the ${pack.requirements.length} requirements` +
      `${pack.mappings.length ? ` and ${pack.mappings.length} mapping entries` : ''} with the primary source:\n  ${pack.version.source.url}\n  ${pack.version.source.citation}`,
  );
  console.log('Next: npm run frameworks:load');
}

// ------------------------------------------------------------------------------------------------ database
async function connect() {
  const connectionString = process.env.DIRECT_URL;
  if (!connectionString) fail('DIRECT_URL is not set (the DIRECT host of the database).');
  if (/-pooler/.test(new URL(connectionString).hostname)) {
    fail('DIRECT_URL points at the POOLED host; use the direct (non-pooler) host.');
  }
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 60_000 });
  await client.connect();
  return client;
}

async function loadOne(client, dir, newId) {
  const pack = readPack(dir);
  const v = pack.version;
  if (v.status !== 'verified') {
    console.log(`- ${v.label}: skipped, it is ${v.status} (a named person must verify it first).`);
    return false;
  }
  const problems = checkPack(pack, dir);
  if (problems.length > 0) fail(`- ${v.label}: refused:\n   ${problems.join('\n   ')}`);

  const framework = await client.query('SELECT id FROM frameworks WHERE code = $1', [
    pack.framework,
  ]);
  if (framework.rowCount !== 1)
    fail(`- ${v.label}: the framework "${pack.framework}" is not in the catalogue.`);
  const frameworkId = framework.rows[0].id;

  const existing = await client.query(
    'SELECT id, content_hash FROM framework_versions WHERE framework_id = $1 AND label = $2',
    [frameworkId, v.label],
  );
  if (existing.rowCount === 1) {
    if (existing.rows[0].content_hash === v.contentHash) {
      console.log(`- ${v.label}: already loaded, unchanged.`);
      return false;
    }
    fail(
      `- ${v.label}: a version with this label is already loaded with DIFFERENT content. Loaded versions never change: give the new content a new label.`,
    );
  }

  const versionId = newId();
  const ids = new Map(pack.requirements.map((requirement) => [requirement.ref, newId()]));

  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO framework_versions (id, framework_id, label, status, licence_class, effective_from, source_url,
         citation, retrieved_at, source_hash, content_hash, verified_by, verified_at, updated_at)
       VALUES ($1, $2, $3, 'VERIFIED', $4::"LicenceClass", $5::date, $6, $7, $8::timestamptz, $9, $10, $11, $12::timestamptz, now())`,
      [
        versionId,
        frameworkId,
        v.label,
        v.licenceClass,
        v.effectiveFrom,
        v.source.url,
        v.source.citation,
        v.source.retrievedAt,
        v.source.sha256,
        v.contentHash,
        v.verifiedBy,
        v.verifiedAt,
      ],
    );
    await client.query(
      `INSERT INTO requirements (id, framework_version_id, parent_id, ref, kind, title, description, text_source, sort_order)
       SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::"TextSource"[], $9::int[])`,
      [
        pack.requirements.map((r) => ids.get(r.ref)),
        pack.requirements.map(() => versionId),
        pack.requirements.map((r) => (r.parent ? ids.get(r.parent) : null)),
        pack.requirements.map((r) => r.ref),
        pack.requirements.map((r) => r.kind),
        pack.requirements.map((r) => r.title),
        pack.requirements.map((r) => r.description ?? null),
        pack.requirements.map((r) => r.textSource),
        pack.requirements.map((r) => r.sortOrder),
      ],
    );

    const entries = [];
    for (const mapping of pack.mappings) {
      const resolve = async (end) => {
        if (end.framework === pack.framework && end.version === v.label) return ids.get(end.ref);
        const found = await client.query(
          `SELECT r.id FROM requirements r
             JOIN framework_versions fv ON fv.id = r.framework_version_id
             JOIN frameworks f ON f.id = fv.framework_id
            WHERE f.code = $1 AND fv.label = $2 AND r.ref = $3 AND fv.status IN ('VERIFIED', 'PUBLISHED')`,
          [end.framework, end.version, end.ref],
        );
        return found.rows[0]?.id;
      };
      const from = await resolve(mapping.from);
      const to = await resolve(mapping.to);
      if (!from || !to)
        throw new Error(
          `mapping ${mapping.from.ref} -> ${mapping.to.ref}: a requirement is not loaded (load its pack first)`,
        );
      entries.push({
        id: newId(),
        from,
        to,
        relationship: mapping.relationship,
        citation: mapping.citation,
      });
    }
    if (entries.length > 0) {
      await client.query(
        `INSERT INTO mapping_pack_entries (id, from_requirement_id, to_requirement_id, relationship, citation)
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::"MappingRelationship"[], $5::text[])`,
        [
          entries.map((e) => e.id),
          entries.map((e) => e.from),
          entries.map((e) => e.to),
          entries.map((e) => e.relationship),
          entries.map((e) => e.citation),
        ],
      );
    }
    await client.query('COMMIT');
    console.log(
      `- ${v.label}: loaded ${pack.requirements.length} requirements and ${entries.length} mapping entries (verified by ${v.verifiedBy}).`,
    );
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function load(args) {
  const dirs = args.length > 0 ? args.map(resolvePackDir) : listPackDirs();
  if (dirs.length === 0) fail('No packs found under prisma/seed-data.');
  const client = await connect();
  try {
    const db = (await client.query('SELECT current_database() AS db')).rows[0].db;
    console.log(`Loading verified packs into database "${db}" ...`);
    const newId = createUuidV7();
    // a pack with mapping entries needs the packs it points at: plain requirement packs go first
    const ordered = [...dirs].sort(
      (a, b) => readPack(a).mappings.length - readPack(b).mappings.length,
    );
    for (const dir of ordered) await loadOne(client, dir, newId);
  } finally {
    await client.end();
  }
}

async function status() {
  const dirs = listPackDirs();
  let client = null;
  if (process.env.DIRECT_URL && !/-pooler/.test(process.env.DIRECT_URL)) {
    try {
      client = await connect();
    } catch {
      client = null;
    }
  }
  try {
    if (dirs.length === 0) console.log('No packs under prisma/seed-data.');
    for (const dir of dirs) {
      const pack = readPack(dir);
      const v = pack.version;
      const problems = checkPack(pack, dir);
      let loaded = '(no database connection)';
      if (client) {
        const row = await client.query(
          `SELECT fv.status::text AS status FROM framework_versions fv JOIN frameworks f ON f.id = fv.framework_id
            WHERE f.code = $1 AND fv.label = $2`,
          [pack.framework, v.label],
        );
        loaded = row.rowCount === 1 ? `loaded (${row.rows[0].status})` : 'not loaded';
      }
      console.log(`${v.label} [${pack.framework}] ${path.relative(PACKS_DIR, dir)}`);
      console.log(
        `  pack: ${v.status}${v.verifiedBy ? ` by ${v.verifiedBy} at ${v.verifiedAt}` : ''}; ${pack.requirements.length} requirements, ${pack.mappings.length} mapping entries`,
      );
      console.log(`  source: ${v.source.url} (retrieved ${v.source.retrievedAt})`);
      console.log(`  database: ${loaded}`);
      if (problems.length > 0) console.log(`  PROBLEMS:\n   - ${problems.join('\n   - ')}`);
    }
  } finally {
    await client?.end();
  }
}

switch (command) {
  case 'extract':
    await extract(positional[0]);
    break;
  case 'verify':
    verify(positional[0]);
    break;
  case 'load':
    await load(positional);
    break;
  case 'status':
    await status();
    break;
  default:
    fail('usage: node scripts/frameworks/cli.mjs <extract|verify|load|status> ...');
}
