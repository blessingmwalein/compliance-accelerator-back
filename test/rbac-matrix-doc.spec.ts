import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, rolesWith } from '../src/permissions/catalogue.js';

/**
 * docs/rbac-matrix.md is what the owner reviews. This test parses its tables and fails when they
 * differ from the catalogue, so the reviewed document and the enforced rules cannot drift apart.
 */
describe('docs/rbac-matrix.md matches the permission catalogue', () => {
  it('lists every permission once, with exactly the roles the catalogue grants', async () => {
    const text = await readFile(new URL('../docs/rbac-matrix.md', import.meta.url), 'utf8');
    const documented = new Map<string, string[]>();

    for (const line of text.split('\n')) {
      const cells = line.split('|').map((cell) => cell.trim());
      const key = /^`([A-Za-z]+\.[A-Za-z]+)`$/.exec(cells[1] ?? '')?.[1];
      if (!key || cells.length < 8) continue;
      expect(documented.has(key), `${key} is documented twice`).toBe(false);
      const marks = cells.slice(2, 8);
      documented.set(
        key,
        ROLES.filter((_, index) => marks[index] === '✓'),
      );
      for (const mark of marks) expect(['✓', '–']).toContain(mark);
    }

    // platform permissions are documented in prose, not in the role tables
    expect([...documented.keys()].sort()).toEqual([...PERMISSIONS].sort());
    for (const permission of PERMISSIONS) {
      expect(documented.get(permission), permission).toEqual([...rolesWith(permission)]);
    }
  });
});
