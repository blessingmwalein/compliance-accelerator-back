// Extracts the NIST CSF 2.0 Core (functions, categories, subcategories) from the official CSF 2.0
// Reference Tool export (an .xlsx) into pack requirements. Nothing is typed from memory: every title is
// the text of the spreadsheet cell. The sheet "CSF 2.0" has one node per row: the Function in column A,
// the Category in column B, the Subcategory in column C.
import { plainText } from './lib.mjs';
import { readZip } from './zip.mjs';

const CELL = /<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

function sharedStrings(zip) {
  const xml = zip.get('xl/sharedStrings.xml')?.().toString('utf8');
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    plainText([...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((text) => text[1]).join('')),
  );
}

/** The path of the worksheet with this name (through workbook.xml and its relationships). */
function sheetPath(zip, name) {
  const workbook = zip.get('xl/workbook.xml')?.().toString('utf8') ?? '';
  const sheet = [...workbook.matchAll(/<sheet [^>]*>/g)]
    .map((match) => match[0])
    .find((tag) => tag.includes(`name="${name}"`));
  const rid = sheet?.match(/r:id="([^"]+)"/)?.[1];
  if (!rid) throw new Error(`The workbook has no sheet named "${name}".`);
  const rels = zip.get('xl/_rels/workbook.xml.rels')?.().toString('utf8') ?? '';
  const rel = [...rels.matchAll(/<Relationship [^>]*>/g)]
    .map((match) => match[0])
    .find((tag) => tag.includes(`Id="${rid}"`));
  const target = rel?.match(/Target="([^"]+)"/)?.[1];
  if (!target) throw new Error(`No relationship ${rid} for sheet "${name}".`);
  return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
}

/** Rows as `{ A, B, C, ... }` of plain text, in sheet order. */
function readRows(zip, strings, path) {
  const xml = zip.get(path)?.().toString('utf8');
  if (!xml) throw new Error(`Missing ${path} in the workbook.`);
  const rows = [];
  for (const row of xml.matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const [, column, , attributes, inner] of row[2].matchAll(CELL)) {
      if (inner === undefined) continue;
      const value = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      if (/t="s"/.test(attributes)) cells[column] = strings[Number(value)] ?? '';
      else if (/t="inlineStr"/.test(attributes)) cells[column] = plainText(inner);
      else if (value !== undefined) cells[column] = plainText(value);
    }
    rows.push({ number: Number(row[1]), cells });
  }
  return rows;
}

const FUNCTION_CELL = /^([A-Z][A-Z .&'-]*?) \(([A-Z]{2})\): (.+)$/;
const CATEGORY_CELL = /^(.+?) \(([A-Z]{2}\.[A-Z]{2})\): (.+)$/;
const SUBCATEGORY_CELL = /^([A-Z]{2}\.[A-Z]{2}-\d{2}): (.+)$/;

/** @param {Buffer} buffer the .xlsx file */
export function extractNist(buffer) {
  const zip = readZip(buffer);
  const strings = sharedStrings(zip);
  const rows = readRows(zip, strings, sheetPath(zip, 'CSF 2.0'));

  const requirements = [];
  const refs = new Set();
  const push = (requirement) => {
    if (refs.has(requirement.ref))
      throw new Error(`Duplicate identifier ${requirement.ref} (row ${requirement.row}).`);
    refs.add(requirement.ref);
    const { row, ...rest } = requirement;
    requirements.push({ ...rest, sortOrder: requirements.length });
    void row;
  };

  let headerSeen = false;
  // The export also lists the CSF 1.1 items that 2.0 withdrew ("[Withdrawn: Incorporated into ...]"). They are
  // not part of the 2.0 Core, so they are left out; the pack says how many.
  const withdrawn = { category: 0, subcategory: 0 };
  const isWithdrawn = (text) => /^\[Withdrawn/i.test(text);
  for (const { number, cells } of rows) {
    const a = cells.A?.trim();
    const b = cells.B?.trim();
    const c = cells.C?.trim();
    if (a === 'Function' && b === 'Category') {
      headerSeen = true; // the rows above it are the banner
      continue;
    }
    if (!headerSeen || (!a && !b && !c)) continue;
    if (a) {
      // the sheet repeats each Function name (without its description) after its last Subcategory
      const repeat = /^[A-Z][A-Z .&'-]*? \(([A-Z]{2})\)$/.exec(a);
      if (repeat && refs.has(repeat[1])) continue;
      const match = FUNCTION_CELL.exec(a);
      if (!match) throw new Error(`Row ${number}: cannot read the Function "${a.slice(0, 60)}".`);
      push({
        row: number,
        ref: match[2],
        kind: 'function',
        title: match[1],
        description: match[3],
        parent: null,
        textSource: 'VERBATIM',
      });
    } else if (b) {
      const match = CATEGORY_CELL.exec(b);
      if (!match) throw new Error(`Row ${number}: cannot read the Category "${b.slice(0, 60)}".`);
      if (isWithdrawn(match[3])) {
        withdrawn.category += 1;
        continue;
      }
      const parent = match[2].slice(0, 2);
      if (!refs.has(parent))
        throw new Error(`Row ${number}: category ${match[2]} comes before its function ${parent}.`);
      push({
        row: number,
        ref: match[2],
        kind: 'category',
        title: match[1],
        description: match[3],
        parent,
        textSource: 'VERBATIM',
      });
    } else if (c) {
      const match = SUBCATEGORY_CELL.exec(c);
      if (!match)
        throw new Error(`Row ${number}: cannot read the Subcategory "${c.slice(0, 60)}".`);
      if (isWithdrawn(match[2])) {
        withdrawn.subcategory += 1;
        continue;
      }
      const parent = match[1].slice(0, 5);
      if (!refs.has(parent))
        throw new Error(
          `Row ${number}: subcategory ${match[1]} comes before its category ${parent}.`,
        );
      // a subcategory is a single outcome statement: it is its own title
      push({
        row: number,
        ref: match[1],
        kind: 'subcategory',
        title: match[2],
        description: null,
        parent,
        textSource: 'VERBATIM',
      });
    }
  }

  const count = (kind) => requirements.filter((requirement) => requirement.kind === kind).length;
  return {
    requirements,
    counts: {
      function: count('function'),
      category: count('category'),
      subcategory: count('subcategory'),
    },
    notes: {
      excludedWithdrawnCategories: withdrawn.category,
      excludedWithdrawnSubcategories: withdrawn.subcategory,
    },
  };
}
