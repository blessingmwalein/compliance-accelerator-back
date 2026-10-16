import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * Writes (or with --check, verifies) contracts/openapi.json without a database or network.
 * Usage: node dist/cli/export-openapi.js [--check] [output-path]
 *
 * The environment is pinned BEFORE the application module is imported so the export is hermetic
 * and deterministic regardless of the developer's shell or .env file.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SWAGGER_ENABLED = 'true';
process.env.DATABASE_URL = '';
// Not a secret: the export never signs anything, it only needs the configuration to validate.
process.env.JWT_ACCESS_SECRET = 'openapi-export-placeholder-0123456789-abcdefghijklmnop';
process.env.JOBS_RUNNER = 'external';
process.env.THROTTLE_ENABLED = 'false';
delete process.env.JOBS_TICK_SECRET;

const args = process.argv.slice(2);
const check = args.includes('--check');
const outputPath = resolve(args.find((arg) => !arg.startsWith('--')) ?? 'contracts/openapi.json');

const { NestFactory } = await import('@nestjs/core');
const { AppModule } = await import('../app.module.js');
const { buildOpenApiDocument } = await import('../common/http/openapi.js');

const app = await NestFactory.create(AppModule, { logger: false });
try {
  const serialised = `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`;

  if (check) {
    const existing = await readFile(outputPath, 'utf8').catch(() => undefined);
    if (existing !== serialised) {
      console.error(
        `OpenAPI contract drift: ${outputPath} is ${existing === undefined ? 'missing' : 'out of date'}.\n` +
          'Run `npm run openapi:export`, review the diff, bump CONTRACT_VERSION and update contracts/CHANGELOG.md.',
      );
      process.exitCode = 1;
    } else {
      console.log(`OpenAPI contract is up to date (${outputPath}).`);
    }
  } else {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialised, 'utf8');
    console.log(`OpenAPI contract written to ${outputPath}.`);
  }
} finally {
  await app.close();
}
