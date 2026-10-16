import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findViolations, importSpecifiers } from './support/architecture-rules.js';

const root = fileURLToPath(new URL('..', import.meta.url));

function readSources(dir: string, into: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'generated') readSources(path, into);
    } else if (path.endsWith('.ts')) {
      into[relative(root, path).split('\\').join('/')] = readFileSync(path, 'utf8');
    }
  }
  return into;
}

describe('architecture rules', () => {
  it('the real source tree has no violations', () => {
    const files = readSources(join(root, 'src'));
    expect(Object.keys(files).length).toBeGreaterThan(20); // guards against scanning nothing
    expect(findViolations(files)).toEqual([]);
  });

  it('reads import specifiers in every form', () => {
    const source = `
      import { A } from './a.js';
      import type { B } from "../b.js";
      export { C } from '@scope/c';
      import './side-effect.js';
      const D = await import('./d.js');
    `;
    expect(importSpecifiers(source)).toEqual(
      expect.arrayContaining(['./a.js', '../b.js', '@scope/c', './side-effect.js', './d.js']),
    );
  });
});

/** Each rule must fail on a planted violation, otherwise the green run above proves nothing. */
describe('architecture rules catch planted violations', () => {
  const violations = (files: Record<string, string>) => findViolations(files).join('\n');

  it('a service importing PrismaService', () => {
    expect(
      violations({
        'src/things/things.service.ts':
          "import { PrismaService } from '../prisma/prisma.service.js';",
      }),
    ).toContain('things.service.ts: imports "../prisma/prisma.service.js"');
  });

  it('a controller importing the generated Prisma client', () => {
    expect(
      violations({
        'src/things/things.controller.ts':
          "import { PrismaClient } from '../generated/prisma/client.js';",
      }),
    ).toContain('imports "../generated/prisma/client.js"');
  });

  it('anything importing @prisma/client or the adapter outside the allowed places', () => {
    expect(
      violations({ 'src/things/x.ts': "import { PrismaClient } from '@prisma/client';" }),
    ).toContain('@prisma/client');
    expect(
      violations({ 'src/things/x.ts': "import { PrismaPg } from '@prisma/adapter-pg';" }),
    ).toContain('@prisma/adapter-pg');
  });

  it('a repository, src/prisma, src/database and src/health are allowed', () => {
    const ok = "import { PrismaService } from '../prisma/prisma.service.js';";
    expect(
      violations({
        'src/things/things.repository.ts': ok,
        'src/database/x.ts': ok,
        'src/health/health.controller.ts': ok,
        'src/prisma/y.ts': ok,
      }),
    ).toBe('');
  });

  it('domain code importing Nest, Prisma, Node built-ins or other layers', () => {
    expect(
      violations({ 'src/domain/scoring/x.ts': "import { Injectable } from '@nestjs/common';" }),
    ).toContain('domain code may only import');
    expect(
      violations({ 'src/domain/scoring/x.ts': "import { readFileSync } from 'node:fs';" }),
    ).toContain('domain code may only import');
    expect(
      violations({
        'src/domain/scoring/x.ts': "import { Tx } from '../../database/db-client.js';",
      }),
    ).toContain('domain code may only import');
    expect(violations({ 'src/domain/scoring/x.ts': "import { band } from './band.js';" })).toBe('');
  });

  it('a controller importing a repository', () => {
    expect(
      violations({
        'src/things/things.controller.ts':
          "import { ThingsRepository } from './things.repository.js';",
      }),
    ).toContain('a controller imports a repository');
  });

  it('raw SQL outside repositories and infrastructure, and unsafe raw SQL anywhere', () => {
    expect(
      violations({ 'src/things/things.service.ts': 'await db.$queryRaw`SELECT 1`;' }),
    ).toContain('raw SQL outside a repository');
    expect(violations({ 'src/things/things.repository.ts': 'await db.$queryRaw`SELECT 1`;' })).toBe(
      '',
    );
    expect(
      violations({ 'src/things/things.repository.ts': 'await db.$queryRawUnsafe(sql);' }),
    ).toContain('forbidden');
  });

  it('console.log in src, except main.ts and the CLI tools', () => {
    expect(violations({ 'src/things/x.ts': "console.log('hi');" })).toContain('console.log');
    expect(
      violations({
        'src/main.ts': "console.log('listening');",
        'src/cli/export.ts': "console.log('x');",
      }),
    ).toBe('');
  });
});
