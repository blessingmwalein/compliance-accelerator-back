/**
 * Mechanical enforcement of the layering rules in .claude/skills/backend-architecture. Pure: it
 * takes `{ 'src/x/y.ts': 'file text' }` so tests can feed it planted violations and prove every
 * rule fails when it should.
 */

const isSpec = (file: string) => /\.(spec|e2e-spec|int-spec)\.ts$/.test(file);

/** Every module specifier a file imports, re-exports or dynamically imports. */
export function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

const PRISMA_SPECIFIER = /(^|\/)generated\/prisma(\/|$)|^@prisma\/|prisma\.service(\.js)?$/;

/** Files that may import Prisma, the generated client or PrismaService. */
function mayUsePrisma(file: string): boolean {
  return (
    isSpec(file) ||
    /\.repository\.ts$/.test(file) ||
    file.startsWith('src/prisma/') ||
    file.startsWith('src/database/') ||
    file.startsWith('src/health/') ||
    file.startsWith('src/generated/')
  );
}

/** Files that may run raw SQL (`$queryRaw`, `$executeRaw`): where cross-tenant leaks hide, so few. */
function mayRunRawSql(file: string): boolean {
  return (
    isSpec(file) ||
    /\.repository\.ts$/.test(file) ||
    file.startsWith('src/prisma/') ||
    file.startsWith('src/database/')
  );
}

export function findViolations(files: Record<string, string>): string[] {
  const problems: string[] = [];

  for (const [file, source] of Object.entries(files)) {
    if (!file.startsWith('src/') || file.startsWith('src/generated/')) continue;
    const specifiers = importSpecifiers(source);

    // 1. Only repositories and infrastructure import Prisma (health probes are the documented exception).
    if (!mayUsePrisma(file)) {
      for (const specifier of specifiers.filter((s) => PRISMA_SPECIFIER.test(s))) {
        problems.push(
          `${file}: imports "${specifier}" but only *.repository.ts, src/prisma, src/database and src/health may`,
        );
      }
    }

    // 2. src/domain is pure: no packages, no Node built-ins, nothing outside src/domain.
    if (file.startsWith('src/domain/') && !isSpec(file)) {
      for (const specifier of specifiers) {
        const staysInDomain =
          specifier.startsWith('./') ||
          (specifier.startsWith('../') &&
            specifier.split('../').length <= 2 &&
            file.split('/').length > 3);
        if (!staysInDomain)
          problems.push(
            `${file}: domain code may only import from src/domain (found "${specifier}")`,
          );
      }
    }

    // 3. Controllers are HTTP only: they never touch repositories.
    if (/\.controller\.ts$/.test(file)) {
      for (const specifier of specifiers.filter((s) => /\.repository(\.js)?$/.test(s))) {
        problems.push(
          `${file}: a controller imports a repository ("${specifier}"); call a service instead`,
        );
      }
    }

    // 4. Raw SQL stays in repositories and infrastructure; the *Unsafe variants are banned outright.
    if (!isSpec(file)) {
      if (/\$(query|execute)RawUnsafe\b/.test(source))
        problems.push(`${file}: $queryRawUnsafe/$executeRawUnsafe are forbidden`);
      if (!mayRunRawSql(file) && /\$(query|execute)Raw\b/.test(source)) {
        problems.push(`${file}: raw SQL outside a repository or src/prisma, src/database`);
      }
    }

    // 5. Structured logging only (main.ts and the CLI tools may write to stdout/stderr).
    if (
      !isSpec(file) &&
      file !== 'src/main.ts' &&
      !file.startsWith('src/cli/') &&
      /\bconsole\.(log|info|debug)\(/.test(source)
    ) {
      problems.push(`${file}: console.log/info/debug in src (use the pino logger)`);
    }
  }

  return problems;
}
