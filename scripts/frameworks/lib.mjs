// Shared helpers of the framework-pack tooling (see cli.mjs and docs/frameworks/source-registry.md).
//
// A PACK is `prisma/seed-data/<framework>/<version>/pack.json` next to the stored source file it was
// extracted from. It is data, not code: requirements (identifiers and titles as the source words them) and,
// only when a cited crosswalk exists, mapping entries. Nothing in a pack is typed from memory.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PACKS_DIR = path.join(ROOT, 'prisma', 'seed-data');

export const LICENCE_CLASSES = ['PUBLIC_DOMAIN', 'OPEN_REUSE', 'LICENSED_TEXT', 'USER_SUPPLIED'];
export const TEXT_SOURCES = ['VERBATIM', 'PARAPHRASE', 'REFERENCE_ONLY'];
export const RELATIONSHIPS = ['EXACT', 'PARTIAL', 'RELATED'];

export const sha256 = (buffer) => `sha256:${createHash('sha256').update(buffer).digest('hex')}`;

/** JSON with sorted keys and no whitespace: the same content always gives the same hash. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The hash a verifier attests to: the requirements and mapping entries, nothing else. */
export const contentHashOf = (pack) =>
  sha256(
    Buffer.from(canonical({ requirements: pack.requirements, mappings: pack.mappings }), 'utf8'),
  );

/** `nist-csf/2.0` (relative to prisma/seed-data) or a directory path. */
export function resolvePackDir(arg) {
  const direct = path.resolve(arg);
  if (existsSync(path.join(direct, 'pack.json'))) return direct;
  const inside = path.join(PACKS_DIR, arg);
  if (existsSync(path.join(inside, 'pack.json'))) return inside;
  throw new Error(`No pack.json found for "${arg}" (looked in ${direct} and ${inside}).`);
}

export function listPackDirs() {
  if (!existsSync(PACKS_DIR)) return [];
  const found = [];
  for (const framework of readdirSync(PACKS_DIR)) {
    const frameworkDir = path.join(PACKS_DIR, framework);
    if (!statSync(frameworkDir).isDirectory()) continue;
    for (const version of readdirSync(frameworkDir)) {
      const dir = path.join(frameworkDir, version);
      if (existsSync(path.join(dir, 'pack.json'))) found.push(dir);
    }
  }
  return found.sort();
}

export const readPack = (dir) => JSON.parse(readFileSync(path.join(dir, 'pack.json'), 'utf8'));

export function writePack(dir, pack) {
  writeFileSync(path.join(dir, 'pack.json'), `${JSON.stringify(pack, null, 2)}\n`);
}

/**
 * Everything that can be checked without a database. Returns a list of problems (empty = sound).
 * The loader refuses a pack with any problem; `status` prints them.
 */
export function checkPack(pack, dir) {
  const problems = [];
  const add = (message) => problems.push(message);
  if (pack.schema !== 1) add(`unsupported schema ${String(pack.schema)}`);
  if (!pack.framework) add('framework is missing');
  const v = pack.version ?? {};
  if (!v.label) add('version.label is missing');
  if (!LICENCE_CLASSES.includes(v.licenceClass))
    add(`version.licenceClass must be one of ${LICENCE_CLASSES.join(', ')}`);
  if (!['draft', 'verified'].includes(v.status))
    add('version.status must be "draft" or "verified"');
  const source = v.source ?? {};
  for (const key of ['url', 'file', 'citation', 'retrievedAt', 'sha256']) {
    if (!source[key]) add(`version.source.${key} is missing`);
  }
  if (source.file) {
    const file = path.join(dir, source.file);
    if (!existsSync(file)) add(`the stored source file ${source.file} is missing`);
    else if (sha256(readFileSync(file)) !== source.sha256) {
      add(
        `the stored source file ${source.file} does not match version.source.sha256 (it was changed)`,
      );
    }
  }

  const requirements = Array.isArray(pack.requirements) ? pack.requirements : [];
  const mappings = Array.isArray(pack.mappings) ? pack.mappings : [];
  const seen = new Set();
  requirements.forEach((requirement, index) => {
    const where = `requirements[${index}] (${requirement.ref ?? '?'})`;
    if (!requirement.ref || requirement.ref.length > 60)
      add(`${where}: ref is missing or too long`);
    if (!requirement.kind || requirement.kind.length > 40)
      add(`${where}: kind is missing or too long`);
    if (!requirement.title || requirement.title.length > 1000)
      add(`${where}: title is missing or too long`);
    if (requirement.description && requirement.description.length > 2000)
      add(`${where}: description is too long`);
    if (!TEXT_SOURCES.includes(requirement.textSource)) add(`${where}: textSource is invalid`);
    if (seen.has(requirement.ref)) add(`${where}: duplicate ref`);
    if (requirement.parent && !seen.has(requirement.parent)) {
      add(`${where}: parent "${requirement.parent}" must appear BEFORE its children`);
    }
    seen.add(requirement.ref);
  });
  mappings.forEach((mapping, index) => {
    const where = `mappings[${index}]`;
    for (const side of ['from', 'to']) {
      const end = mapping[side] ?? {};
      if (!end.framework || !end.version || !end.ref)
        add(`${where}.${side} needs framework, version and ref`);
    }
    if (!RELATIONSHIPS.includes(mapping.relationship)) add(`${where}: relationship is invalid`);
    if (!mapping.citation || mapping.citation.length > 500) {
      add(
        `${where}: a mapping needs a citation (the crosswalk or named reviewer), up to 500 characters`,
      );
    }
  });

  if (contentHashOf({ requirements, mappings }) !== v.contentHash) {
    add(
      'version.contentHash does not match the requirements and mappings (the content changed after extraction or verification)',
    );
  }
  if (v.status === 'verified') {
    if (!v.verifiedBy || v.verifiedBy.trim().length < 2)
      add('a verified pack needs version.verifiedBy');
    if (!v.verifiedAt) add('a verified pack needs version.verifiedAt');
  }
  return problems;
}

/** Monotonic UUIDv7 generator: ids sort in creation order, also within one millisecond. */
export function createUuidV7() {
  let lastMs = 0;
  let counter = 0;
  return () => {
    const now = Date.now();
    if (now > lastMs) {
      lastMs = now;
      counter = 0;
    } else {
      counter += 1;
      if (counter > 0xfff) {
        lastMs += 1;
        counter = 0;
      }
    }
    const bytes = randomBytes(16);
    bytes.writeUIntBE(lastMs, 0, 6);
    bytes[6] = 0x70 | (counter >> 8);
    bytes[7] = counter & 0xff;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

/** Decodes the XML/HTML entities that occur in the sources and collapses white space. */
export function plainText(markup) {
  return markup
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[\s ]+/g, ' ')
    .trim();
}
