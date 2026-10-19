// Keeps the AI-facing documentation honest. Validates, with no dependencies:
//   1. every required skill exists with valid frontmatter, the required headings in order,
//      a code example, a checklist and a minimum amount of content;
//   2. CLAUDE.md links every skill;
//   3. required docs/config files exist and relative links inside Markdown resolve;
//   4. .env.example documents every key read by src/config/env.schema.ts;
//   5. .gitignore protects .env.
// Usage: npm run check:docs
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const fail = (message) => problems.push(message);

const REQUIRED_SKILLS = [
  'backend-architecture',
  'database-and-tenancy',
  'security-and-rbac',
  'forms-and-validation',
  'grc-domain',
  'testing-and-quality',
  'reports-and-documents',
  'notifications-and-jobs',
  'compliance-frameworks',
];
const REQUIRED_HEADINGS = [
  '## When to use',
  '## Rules',
  '## Example',
  '## Anti-patterns',
  '## Checklist',
  '## References',
];
const REQUIRED_FILES = [
  'CLAUDE.md',
  'README.md',
  '.env.example',
  '.gitignore',
  'docs/architecture.md',
  'docs/implementation-plan.md',
  'docs/acceptance-criteria.md',
  'docs/integration.md',
  'docs/deployment-vercel.md',
  'docs/security-baseline.md',
  'docs/rbac-matrix.md',
  'docs/neon-setup.md',
  'docs/metrics/README.md',
  'docs/frameworks/source-registry.md',
  'docs/reference/legacy-findings.md',
  'docs/adr/0001-toolchain-pins.md',
  'contracts/openapi.json',
  'contracts/CHANGELOG.md',
];
const MARKDOWN_WITH_LINKS = ['CLAUDE.md', 'README.md', 'docs'];

const exists = (path) =>
  access(resolve(root, path)).then(
    () => true,
    () => false,
  );
const read = (path) => readFile(resolve(root, path), 'utf8').catch(() => undefined);

// 1 + 2. skills and CLAUDE.md
const claude = (await read('CLAUDE.md')) ?? '';
for (const name of REQUIRED_SKILLS) {
  const path = `.claude/skills/${name}/SKILL.md`;
  const text = await read(path);
  if (text === undefined) {
    fail(`${path} is missing`);
    continue;
  }

  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  if (!new RegExp(`^name:\\s*${name}\\s*$`, 'm').test(frontmatter))
    fail(`${path}: frontmatter name must be "${name}"`);
  const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1] ?? '';
  if (description.length < 60)
    fail(`${path}: frontmatter description is missing or too short (< 60 chars)`);

  let cursor = -1;
  for (const heading of REQUIRED_HEADINGS) {
    const index = text.indexOf(`\n${heading}\n`);
    if (index === -1) fail(`${path}: missing heading "${heading}"`);
    else if (index < cursor) fail(`${path}: heading "${heading}" is out of order`);
    else cursor = index;
  }
  if (!text.includes('```')) fail(`${path}: needs at least one fenced code example`);
  if ((text.match(/^\s*- \[ \]/gm) ?? []).length < 3)
    fail(`${path}: checklist needs at least 3 "- [ ]" items`);
  if (text.split('\n').length < 60) fail(`${path}: too short (< 60 lines) to be a useful skill`);

  if (!claude.includes(path)) fail(`CLAUDE.md does not link ${path}`);
}

// 3. required files and relative links
for (const file of REQUIRED_FILES) if (!(await exists(file))) fail(`${file} is missing`);

async function markdownFiles(entry) {
  const { readdir, stat } = await import('node:fs/promises');
  const full = resolve(root, entry);
  const info = await stat(full).catch(() => undefined);
  if (!info) return [];
  if (info.isFile()) return entry.endsWith('.md') ? [entry] : [];
  const names = await readdir(full);
  const nested = await Promise.all(names.map((name) => markdownFiles(`${entry}/${name}`)));
  return nested.flat();
}

for (const file of (await Promise.all(MARKDOWN_WITH_LINKS.map(markdownFiles))).flat()) {
  const text = (await read(file)) ?? '';
  const withoutCode = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const match of withoutCode.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
    const target = match[1];
    if (/^[a-z]+:/i.test(target) || target.startsWith('mailto:')) continue; // external
    const resolved = resolve(root, dirname(file), target);
    const insideRepo = resolved.startsWith(root);
    // links that leave the repository (the sibling frontend) are checked only when the sibling exists
    const present = await access(resolved).then(
      () => true,
      () => false,
    );
    if (!present && insideRepo) fail(`${file}: broken relative link "${target}"`);
  }
}

// 4. .env.example vs env schema
const schema = (await read('src/config/env.schema.ts')) ?? '';
const classBody = /class EnvironmentVariables \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? '';
const envKeys = [...classBody.matchAll(/^\s{2}([A-Z][A-Z0-9_]+)[?!]?\s*[:=]/gm)].map((m) => m[1]);
const envExample = (await read('.env.example')) ?? '';
if (envKeys.length === 0) fail('could not read keys from src/config/env.schema.ts');
for (const key of [...envKeys, 'DIRECT_URL']) {
  if (!new RegExp(`^${key}=`, 'm').test(envExample))
    fail(`.env.example does not document ${key} (expected a "${key}=" line)`);
}

// 5. secrets hygiene
const gitignore = (await read('.gitignore')) ?? '';
if (!/^\.env$/m.test(gitignore)) fail('.gitignore must ignore .env');
if (!/^!\.env\.example$/m.test(gitignore))
  fail('.gitignore must keep .env.example tracked (!.env.example)');

if (problems.length > 0) {
  console.error(`check:docs found ${problems.length} problem(s):`);
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.log(
  `check:docs ok (${REQUIRED_SKILLS.length} skills, ${REQUIRED_FILES.length} files, ${envKeys.length + 1} env keys).`,
);
