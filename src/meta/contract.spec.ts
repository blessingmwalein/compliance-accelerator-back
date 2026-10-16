import { readFileSync } from 'node:fs';
import { CONTRACT_VERSION } from './contract-version.js';

const contractPath = new URL('../../contracts/openapi.json', import.meta.url);
const changelogPath = new URL('../../contracts/CHANGELOG.md', import.meta.url);

describe('contract files', () => {
  it('contracts/openapi.json declares the same version as CONTRACT_VERSION', () => {
    const document = JSON.parse(readFileSync(contractPath, 'utf8')) as {
      info: { version: string };
    };
    expect(document.info.version).toBe(CONTRACT_VERSION);
  });

  it('contracts/CHANGELOG.md has an entry for the current CONTRACT_VERSION', () => {
    expect(readFileSync(changelogPath, 'utf8')).toContain(`## ${CONTRACT_VERSION}`);
  });
});
