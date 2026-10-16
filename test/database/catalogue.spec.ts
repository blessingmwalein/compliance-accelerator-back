import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GLOBAL_TABLES, TENANT_MODELS, TENANT_ROOT_TABLES } from '../../src/database/catalogue.js';
import { checkCatalogue, parseSchema, type Catalogue } from '../support/schema-catalogue.js';

const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');

const catalogue: Catalogue = {
  tenantModels: TENANT_MODELS,
  globalTables: Object.keys(GLOBAL_TABLES),
  tenantRootTables: TENANT_ROOT_TABLES,
};

describe('tenancy catalogue vs prisma/schema.prisma', () => {
  it('parses every model of the real schema', () => {
    const names = parseSchema(schema).map((model) => model.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'Organisation',
        'User',
        'Membership',
        'AuditEvent',
        'IdempotencyKey',
      ]),
    );
  });

  it('the real schema follows every tenancy convention', () => {
    expect(checkCatalogue(schema, catalogue)).toEqual([]);
  });
});

/**
 * The checker must fail when a rule is broken, otherwise a green catalogue test proves nothing.
 * Each case edits the real schema or adds a model and expects a specific violation.
 */
describe('checkCatalogue catches violations', () => {
  const violationsFor = (mutated: string) => checkCatalogue(mutated, catalogue).join('\n');

  it('a table with neither organisation_id nor a catalogue entry', () => {
    const bad = `${schema}\nmodel Widget {\n  id String @id @default(uuid(7)) @db.Uuid\n  @@map("widgets")\n}\n`;
    expect(violationsFor(bad)).toContain(
      'Widget: table "widgets" has no organisationId and is neither in GLOBAL_TABLES',
    );
  });

  it('a tenant table that is missing from TENANT_MODELS', () => {
    const bad = `${schema}
model Widget {
  id             String @id @default(uuid(7)) @db.Uuid
  organisationId String @map("organisation_id") @db.Uuid
  @@index([organisationId])
  @@map("widgets")
}
`;
    expect(violationsFor(bad)).toContain(
      'Widget: has organisationId but is missing from TENANT_MODELS',
    );
  });

  it('a nullable organisationId', () => {
    const bad = schema.replace(
      /organisationId String(\s+)@map\("organisation_id"\) @db.Uuid\n(\s+)userId/,
      'organisationId String?$1@map("organisation_id") @db.Uuid\n$2userId',
    );
    expect(bad).not.toBe(schema);
    expect(violationsFor(bad)).toContain('Membership: organisationId must not be nullable');
  });

  it('an id that is not UUIDv7', () => {
    const bad = schema.replace(
      /(model Membership \{\s+id\s+String\s+@id @default\()uuid\(7\)/,
      '$1uuid()',
    );
    expect(bad).not.toBe(schema);
    expect(violationsFor(bad)).toContain('Membership: id must be @default(uuid(7))');
  });

  it('a tenant table with no index that leads with organisationId', () => {
    const bad = `${schema}
model Widget {
  id             String @id @default(uuid(7)) @db.Uuid
  organisationId String @map("organisation_id") @db.Uuid
  name           String
  @@index([name])
  @@map("widgets")
}
`;
    expect(violationsFor(bad)).toContain(
      'Widget: needs an @@index or @@unique that starts with organisationId',
    );
  });

  it('a relation between tenant models that is not a composite FK', () => {
    const bad = `${schema}
model Parent {
  id             String   @id @default(uuid(7)) @db.Uuid
  organisationId String   @map("organisation_id") @db.Uuid
  children       Child[]
  @@unique([organisationId, id])
  @@map("parents")
}
model Child {
  id             String @id @default(uuid(7)) @db.Uuid
  organisationId String @map("organisation_id") @db.Uuid
  parentId       String @map("parent_id") @db.Uuid
  parent         Parent @relation(fields: [parentId], references: [id])
  @@index([organisationId])
  @@map("children")
}
`;
    expect(violationsFor(bad)).toContain(
      'Child.parent: relation to tenant model Parent must be a composite FK',
    );
  });

  it('a composite FK whose parent lacks the matching @@unique', () => {
    const bad = `${schema}
model Parent {
  id             String   @id @default(uuid(7)) @db.Uuid
  organisationId String   @map("organisation_id") @db.Uuid
  children       Child[]
  @@index([organisationId])
  @@map("parents")
}
model Child {
  id             String @id @default(uuid(7)) @db.Uuid
  organisationId String @map("organisation_id") @db.Uuid
  parentId       String @map("parent_id") @db.Uuid
  parent         Parent @relation(fields: [organisationId, parentId], references: [organisationId, id])
  @@index([organisationId])
  @@map("children")
}
`;
    expect(violationsFor(bad)).toContain(
      'Parent needs @@unique([organisationId, id]) as the composite FK target',
    );
  });

  it('a correct composite FK passes', () => {
    const good = `${schema}
model Parent {
  id             String   @id @default(uuid(7)) @db.Uuid
  organisationId String   @map("organisation_id") @db.Uuid
  children       Child[]
  @@unique([organisationId, id])
  @@map("parents")
}
model Child {
  id             String @id @default(uuid(7)) @db.Uuid
  organisationId String @map("organisation_id") @db.Uuid
  parentId       String @map("parent_id") @db.Uuid
  parent         Parent @relation(fields: [organisationId, parentId], references: [organisationId, id])
  @@index([organisationId])
  @@map("children")
}
`;
    const problems = checkCatalogue(good, {
      ...catalogue,
      tenantModels: [...TENANT_MODELS, 'Parent', 'Child'],
    });
    expect(problems).toEqual([]);
  });

  it('a catalogue entry for a table that does not exist', () => {
    const problems = checkCatalogue(schema, {
      ...catalogue,
      globalTables: [...catalogue.globalTables, 'ghosts'],
    });
    expect(problems.join('\n')).toContain(
      'catalogue lists "ghosts" but the schema has no such table',
    );
  });
});
