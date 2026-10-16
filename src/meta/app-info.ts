import { readFileSync } from 'node:fs';

interface PackageJson {
  name: string;
  version: string;
}

let cached: PackageJson | undefined;

/** Reads name/version from package.json once (works from both `src/` and `dist/`). */
export function readAppInfo(): PackageJson {
  cached ??= JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as PackageJson;
  return cached;
}
