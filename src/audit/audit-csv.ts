import type { AuditEventRecord } from './audit.repository.js';

/**
 * One export carries this many events at most. A trail is append-only and never pruned, so "everything
 * since the beginning" is not a download — it is a table scan and a file nobody can open. The caller is
 * told to narrow the period instead of being handed a silent half.
 */
export const MAX_AUDIT_EXPORT_ROWS = 5000;

const HEADER = [
  'occurred_at',
  'actor_type',
  'actor_user_id',
  'action',
  'entity_type',
  'entity_id',
  'entity_label',
  'outcome',
  'request_id',
  'changes',
];

/** The longest `changes` cell a reader gets. The marker says so; the JSON list endpoint holds the full values. */
const CHANGES_CELL_LIMIT = 1000;

const CRLF = '\r\n';

/**
 * RFC 4180 quoting with two defences added, because these cells are user-controlled text that people open
 * in a spreadsheet: a line break inside a value would split one event over several rows, and a value that
 * starts with `=`, `+`, `-` or `@` is evaluated as a formula by Excel.
 */
const cell = (value: string | null): string => {
  if (value === null || value === '') return '""';
  const flat = value.replace(/[\r\n\t]+/g, ' ');
  const safe = /^[=+\-@]/.test(flat) ? `'${flat}` : flat;
  return `"${safe.replace(/"/g, '""')}"`;
};

const changesCell = (changes: unknown): string => {
  if (changes === null || changes === undefined) return '""';
  const json = JSON.stringify(changes) ?? '';
  if (json === '') return '""';
  return cell(
    json.length > CHANGES_CELL_LIMIT ? `${json.slice(0, CHANGES_CELL_LIMIT)} [truncated]` : json,
  );
};

const line = (event: AuditEventRecord): string =>
  [
    event.occurredAt.toISOString(),
    event.actorType,
    event.actorUserId,
    event.action,
    event.entityType,
    event.entityId,
    event.entityLabel,
    event.outcome,
    event.requestId,
  ]
    .map(cell)
    .concat(changesCell(event.changes))
    .join(',');

/**
 * The trail as a spreadsheet. The byte-order mark is not decoration: without it Excel reads a UTF-8 file as
 * Windows-1252 and every accented name in the trail arrives mangled.
 */
export function auditCsv(rows: readonly AuditEventRecord[]): string {
  return [`\uFEFF${HEADER.map(cell).join(',')}`, ...rows.map(line)].join(CRLF) + CRLF;
}
