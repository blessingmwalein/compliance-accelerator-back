/**
 * Reads `prisma/schema.prisma` as text and checks the tenancy conventions of the
 * database-and-tenancy skill. Pure (no file access) so tests can feed it deliberately broken
 * schemas and prove each rule fails when it should.
 */

export interface ParsedRelation {
  field: string;
  target: string;
  fields: string[];
  references: string[];
}

export interface ParsedModel {
  name: string;
  table: string | undefined;
  /** field name -> raw line (without comments) */
  fields: Map<string, string>;
  relations: ParsedRelation[];
  /** @@index / @@unique column lists, in declaration order */
  indexes: string[][];
  uniques: string[][];
  idLine: string | undefined;
}

export interface Catalogue {
  tenantModels: readonly string[];
  globalTables: readonly string[];
  tenantRootTables: readonly string[];
}

const list = (text: string | undefined): string[] =>
  (text ?? '')
    .split(',')
    .map((item) => item.trim().replace(/\(.*$/, ''))
    .filter(Boolean);

export function parseSchema(schema: string): ParsedModel[] {
  const models: ParsedModel[] = [];
  const blocks = schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm);

  for (const [, name, body = ''] of blocks) {
    const model: ParsedModel = {
      name: name!,
      table: undefined,
      fields: new Map(),
      relations: [],
      indexes: [],
      uniques: [],
      idLine: undefined,
    };

    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/\/\/.*$/, '').trim();
      if (!line) continue;

      if (line.startsWith('@@')) {
        const map = /^@@map\("([^"]+)"\)/.exec(line);
        if (map) model.table = map[1];
        const index = /^@@(index|unique)\(\[([^\]]*)\]/.exec(line);
        if (index) (index[1] === 'index' ? model.indexes : model.uniques).push(list(index[2]));
        continue;
      }

      const field = /^(\w+)\s+([\w.]+)(\[\]|\?)?\s*(.*)$/.exec(line);
      if (!field) continue;
      const [, fieldName, type, , rest = ''] = field;
      model.fields.set(fieldName!, line);
      if (rest.includes('@id')) model.idLine = line;

      const relation = /@relation\(([^)]*)\)/.exec(rest);
      if (relation) {
        const args = relation[1] ?? '';
        model.relations.push({
          field: fieldName!,
          target: type!,
          fields: list(/fields:\s*\[([^\]]*)\]/.exec(args)?.[1]),
          references: list(/references:\s*\[([^\]]*)\]/.exec(args)?.[1]),
        });
      }
    }
    models.push(model);
  }
  return models;
}

/** Returns human-readable violations; an empty array means the schema follows every convention. */
export function checkCatalogue(schema: string, catalogue: Catalogue): string[] {
  const models = parseSchema(schema);
  const problems: string[] = [];
  const byName = new Map(models.map((model) => [model.name, model]));

  if (models.length === 0) return ['no models found: the schema parser is broken'];

  const tenantByTable = new Set<string>();
  for (const model of models) {
    const label = `${model.name}`;
    if (!model.table) {
      problems.push(`${label}: missing @@map("snake_case_table")`);
      continue;
    }
    if (!/^[a-z][a-z0-9_]*$/.test(model.table))
      problems.push(`${label}: table "${model.table}" is not snake_case`);
    if (!model.idLine?.includes('@default(uuid(7))'))
      problems.push(`${label}: id must be @default(uuid(7))`);

    const orgField = model.fields.get('organisationId');
    const isTenant = orgField !== undefined;
    const isGlobal =
      model.table in Object.fromEntries(catalogue.globalTables.map((t) => [t, true]));
    const isRoot = catalogue.tenantRootTables.includes(model.table);

    if (isTenant) {
      tenantByTable.add(model.table);
      if (/\?/.test(orgField.split(/\s+/)[1] ?? ''))
        problems.push(`${label}: organisationId must not be nullable`);
      if (!orgField.includes('@map("organisation_id")'))
        problems.push(`${label}: organisationId must be @map("organisation_id")`);
      if (!orgField.includes('@db.Uuid'))
        problems.push(`${label}: organisationId must be @db.Uuid`);
      if (!catalogue.tenantModels.includes(model.name)) {
        problems.push(
          `${label}: has organisationId but is missing from TENANT_MODELS (src/database/catalogue.ts)`,
        );
      }
      if (isGlobal || isRoot)
        problems.push(`${label}: has organisationId but is also listed as global or root`);

      const leadsWithOrg = [...model.indexes, ...model.uniques].some(
        (columns) => columns[0] === 'organisationId',
      );
      if (!leadsWithOrg)
        problems.push(`${label}: needs an @@index or @@unique that starts with organisationId`);
    } else if (!isGlobal && !isRoot) {
      problems.push(
        `${label}: table "${model.table}" has no organisationId and is neither in GLOBAL_TABLES nor TENANT_ROOT_TABLES`,
      );
    }

    if (catalogue.tenantModels.includes(model.name) && !isTenant) {
      problems.push(`${label}: listed in TENANT_MODELS but has no organisationId field`);
    }
  }

  const tables = new Set(models.map((model) => model.table));
  for (const table of [...catalogue.globalTables, ...catalogue.tenantRootTables]) {
    if (!tables.has(table))
      problems.push(`catalogue lists "${table}" but the schema has no such table`);
  }
  for (const name of catalogue.tenantModels) {
    if (!byName.has(name))
      problems.push(`TENANT_MODELS lists "${name}" but the schema has no such model`);
  }

  // Composite foreign keys: a tenant row may only point at a parent of the SAME tenant.
  for (const child of models.filter((model) => model.fields.has('organisationId'))) {
    for (const relation of child.relations) {
      if (relation.fields.length === 0) continue; // the back-reference side owns no columns
      const parent = byName.get(relation.target);
      if (!parent || !parent.fields.has('organisationId')) continue; // root or global parent: a plain FK is right
      const where = `${child.name}.${relation.field}`;
      if (
        !relation.fields.includes('organisationId') ||
        !relation.references.includes('organisationId')
      ) {
        problems.push(
          `${where}: relation to tenant model ${parent.name} must be a composite FK including organisationId`,
        );
        continue;
      }
      const hasTarget = parent.uniques.some(
        (columns) =>
          columns.length === relation.references.length &&
          columns.every((c) => relation.references.includes(c)),
      );
      if (!hasTarget) {
        problems.push(
          `${where}: ${parent.name} needs @@unique([${relation.references.join(', ')}]) as the composite FK target`,
        );
      }
    }
  }

  return problems;
}
