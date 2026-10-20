import type { BreachDto, BreachSummaryDto } from '../../breaches/breaches.dto.js';
import type { DashboardSummaryDto } from '../../dashboard/dashboard.dto.js';
import type { RiskLevel } from '../../domain/scoring/methodologies.js';
import type { DsarRequestDto, DsarSlaDto } from '../../dsar/dsar.dto.js';
import type { LawfulBasisRecordDto } from '../../lawful-basis/lawful-basis.dto.js';
import type {
  LegalHoldDto,
  RetentionDisposalDto,
  RetentionRuleDto,
} from '../../retention/retention.dto.js';
import type { RiskDto, RiskSummaryDto } from '../../risks/risks.dto.js';
import type { RopaActivityDto, RopaMonitorDto } from '../../ropa/ropa.dto.js';
import {
  CONTENT_WIDTH,
  PAGE_MARGINS,
  rule,
  type PdfBlock,
  type PdfDocument,
} from '../pdf-document.js';
import { DPO_PERIODS, DEFAULT_DPO_PERIOD, type DpoPeriodValue } from '../reports.dto.js';
import type { ReportTemplateDefinition } from './registry.js';

/**
 * The Consolidated DPO Report (Phase 9a): the one document whose audience is outside the organisation. It
 * draws the seven things a data protection officer has to be able to state at once — the governance position,
 * the record of processing, the risks, the lawful bases, the requests, the breaches and the retention
 * schedule — for one period, each section read through the module that owns it.
 *
 * Two things follow from that audience and are held to throughout the document. Nothing is invented: a figure
 * a module cannot state is printed as its own absence, and a section with no records says so rather than
 * showing an empty table. And no name of a person is printed unless the register itself shows it to the same
 * reader: the data subject behind a request is deliberately left out, because this PDF leaves the building.
 */

/** What the caller chooses: the window, and whether the document carries its confidentiality marking. */
export interface ConsolidatedDpoParams {
  readonly period: DpoPeriodValue;
  readonly confidential: boolean;
}

/** The period the document covered, as the document states it: two inclusive days and the preset behind them. */
export interface ConsolidatedDpoWindow {
  readonly preset: DpoPeriodValue;
  /** Inclusive, in the organisation's own zone; null means the document has no lower bound. */
  readonly from: string | null;
  /** Inclusive: the day the document was drawn. */
  readonly to: string;
  readonly label: string;
}

const PERIOD_LABEL: Record<DpoPeriodValue, string> = {
  last_30_days: 'the last 30 days',
  last_6_months: 'the last 6 months',
  this_year: 'this calendar year',
  all: 'all time',
};

const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);
const dayText = (instant: number): string => new Date(instant).toISOString().slice(0, 10);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The window a preset names, counted back from the day the document is drawn. Whole days, in the
 * organisation's zone: a period that ended at an hour of the UTC clock would cut records out of one reader's
 * document and into another's.
 */
export function windowOf(preset: DpoPeriodValue, today: string): ConsolidatedDpoWindow {
  const current = new Date(dayNumber(today));
  const from =
    preset === 'last_30_days'
      ? dayText(current.getTime() - 29 * DAY_MS)
      : preset === 'last_6_months'
        ? (() => {
            const back = new Date(current.getTime());
            back.setUTCMonth(back.getUTCMonth() - 6);
            return dayText(back.getTime());
          })()
        : preset === 'this_year'
          ? `${current.getUTCFullYear()}-01-01`
          : null;
  return { preset, from, to: today, label: PERIOD_LABEL[preset] ?? preset };
}

/** Whether a day falls inside the window. A missing day never does: an unknown date is not evidence. */
export const inWindow = (
  day: string | null,
  window: Pick<ConsolidatedDpoWindow, 'from' | 'to'>,
): boolean => day !== null && (window.from === null || day >= window.from) && day <= window.to;

/**
 * The rows one section prints, with what the scan could not reach. A long register is never cut in silence:
 * the counts the document prints say how many in-scope records it left out, and whether it read every row.
 */
export interface DpoRows<T> {
  readonly rows: readonly T[];
  /** In-scope records found but not printed, because the table has a length the document states. */
  readonly notPrinted: number;
  /** False when the register held more rows than this document reads: then the counts are of what was read. */
  readonly complete: boolean;
}

/** Everything the document renders, as stored in the report's snapshot. This IS the record. */
export interface ConsolidatedDpoData {
  readonly reportId: string;
  readonly organisationName: string;
  readonly timezone: string;
  readonly generatedAt: Date;
  readonly params: ConsolidatedDpoParams;
  readonly window: ConsolidatedDpoWindow;
  readonly governance: DashboardSummaryDto;
  readonly ropa: { readonly monitor: RopaMonitorDto; readonly rows: DpoRows<RopaActivityDto> };
  readonly risks: { readonly summary: RiskSummaryDto; readonly rows: DpoRows<RiskDto> };
  readonly lawfulBasis: DpoRows<LawfulBasisRecordDto>;
  readonly dsar: { readonly sla: DsarSlaDto; readonly rows: DpoRows<DsarRequestDto> };
  readonly breaches: { readonly summary: BreachSummaryDto; readonly rows: DpoRows<BreachDto> };
  readonly retention: {
    readonly rules: DpoRows<RetentionRuleDto>;
    readonly holds: DpoRows<LegalHoldDto>;
    readonly disposals: DpoRows<RetentionDisposalDto>;
  };
  readonly scoringDisclaimer: string;
}

/**
 * One definition per template (skill: reports-and-documents). The permission it needs is NOT declared here:
 * `REPORT_PERMISSIONS` is shared with the handler's decorator, so the two cannot drift.
 */
export const consolidatedDpo = {
  id: 'consolidated_dpo',
  version: 1,
  title: 'Consolidated DPO Report',
  description:
    'Every register of the organisation for one period — governance, records of processing, risks, lawful bases, requests, breaches and retention — in the document a data protection officer sends outward.',
  generate: 'async',
  params: [
    {
      name: 'period',
      type: 'enum',
      required: false,
      description:
        'The window the document covers, counted back whole days from the day it is drawn.',
      values: DPO_PERIODS,
      default: DEFAULT_DPO_PERIOD,
    },
    {
      name: 'confidential',
      type: 'boolean',
      required: false,
      description:
        'Print the confidentiality marking on the cover and in the running head. Omit for true.',
      default: 'true',
    },
  ],
} as const satisfies ReportTemplateDefinition;

const NOT_ASSESSED = 'Not assessed';
const NO_RECORDS = 'No records';
const NOT_SET = 'Not set';

/** The rule the cover states, so a reader can tell what a section counted without reading the code. */
const INCLUSION_RULE =
  'A record is in scope when it was open, active or recorded during the period. A record with no date to judge by is in scope when it is live: an activity, basis or rule that has not been archived, a risk or breach that has not been closed, and a request that has not been completed, refused or withdrawn.';

/** The one sentence that says why a data subject is not named in a document that leaves the organisation. */
const DSAR_IDENTITY_NOTE =
  "Requests are listed without the data subject's name or address: this document is written under the report permission and is meant to be sent outward, and the tracker remains the record of who asked.";

/** The band colours the register, the assessment PDF and the dashboard all use. */
const BAND_COLOR: Record<RiskLevel, string> = {
  LOW: '#2e7d32',
  MEDIUM: '#b28704',
  HIGH: '#e65100',
  CRITICAL: '#c62828',
};

const REVIEW_LABEL: Record<string, string> = {
  not_reviewed: 'No due date',
  overdue: 'Overdue',
  due_soon: 'Due soon',
  ok: 'On track',
};

const RISK_STATUS_LABEL: Record<string, string> = {
  OPEN: 'Open',
  IN_TREATMENT: 'In treatment',
  ACCEPTED: 'Accepted',
  TRANSFERRED: 'Transferred',
  CLOSED: 'Closed',
};

const BREACH_STATUS_LABEL: Record<string, string> = {
  RECORDED: 'Recorded',
  INVESTIGATING: 'Investigating',
  REMEDIATING: 'Remediating',
  CLOSED: 'Closed',
};

const NOTIFICATION_LABEL: Record<string, string> = {
  UNDECIDED: 'Duty undecided',
  NOTIFICATION_REQUIRED: 'Notification required',
  NOT_REQUIRED: 'Notification not required',
};

const DSAR_STATUS_LABEL: Record<string, string> = {
  RECEIVED: 'Received',
  VERIFYING: 'Verifying identity',
  IN_PROGRESS: 'In progress',
  ON_HOLD: 'On hold',
  COMPLETED: 'Completed',
  REFUSED: 'Refused',
  WITHDRAWN: 'Withdrawn',
};

const ROPA_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  ARCHIVED: 'Archived',
};

const BASIS_REVIEW_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  UNDER_REVIEW: 'Under review',
  APPROVED: 'Approved',
};

const label = (map: Record<string, string>, value: string): string => map[value] ?? value;

const stampIn = (timezone: string, when: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(when)
    .replace(',', '');

const num = (value: number | null): string => (value === null ? NOT_ASSESSED : String(value));

const reviewText = (state: string, dueOn: string | null): string =>
  dueOn === null ? label(REVIEW_LABEL, state) : `${label(REVIEW_LABEL, state)} (${dueOn})`;

/** The period line, in the reader's words: an unbounded window is stated as one, not as an empty date. */
const periodText = (window: ConsolidatedDpoWindow): string =>
  window.from === null
    ? `Since records begin, to ${window.to} — ${window.label}`
    : `${window.from} to ${window.to} — ${window.label}`;

const CONFIDENTIAL_MARK = 'CONFIDENTIAL — DPO Report';

/** How to address the document: the marking is configurable because the same data goes to a board and to a regulator. */
const markingBlock = (data: ConsolidatedDpoData): PdfBlock =>
  data.params.confidential
    ? {
        text: CONFIDENTIAL_MARK,
        style: 'marking',
        margin: [0, 6, 0, 0],
      }
    : { text: '' };

const metaTable = (data: ConsolidatedDpoData): PdfBlock => {
  const rows: readonly (readonly [string, string])[] = [
    ['Organisation', data.organisationName],
    ['Period', periodText(data.window)],
    ['Position as of', `${data.governance.asOf} (${data.timezone})`],
    ['Methodology', methodologyLine(data.governance)],
    [
      'Exposure band',
      data.governance.exposure.band === null
        ? NOT_ASSESSED
        : `${data.governance.exposure.band.label} (${data.governance.exposure.band.min}-${data.governance.exposure.band.max})`,
    ],
    ['Generated', `${stampIn(data.timezone, data.generatedAt)} (${data.timezone})`],
    ['Report', data.reportId],
  ];
  return {
    table: {
      widths: [118, CONTENT_WIDTH - 118],
      body: rows.map(([key, value]) => [
        { text: key, style: 'metaLabel' },
        { text: value, style: 'metaValue' },
      ]),
    },
    layout: 'noBorders',
  };
};

const methodologyLine = (summary: DashboardSummaryDto): string => {
  const list = summary.exposure.methodologies;
  if (list.length === 0) return 'No scored cycle';
  return list.map((item) => `${item.id} v${item.version}`).join(' · ');
};

/** A figure that cannot be stated has no scale to name: "Not assessed of 5" would invent one. */
const withScale = (measured: { value: number | null }, scale: string): string =>
  measured.value === null ? NOT_ASSESSED : `${measured.value}${scale}`;

/** The seven sections, in the order the document prints them. The contents page and the body read this list. */
const SECTIONS = [
  {
    title: 'Governance position',
    holds: 'Maturity, exposure and the work the counted cycles carry.',
  },
  {
    title: 'Record of processing activities',
    holds: 'The live activities and how much of them needs a review.',
  },
  { title: 'Risk register', holds: 'The risks carried in the period, with their residual bands.' },
  { title: 'Lawful bases', holds: 'Why each processing is done, and which basis says so.' },
  {
    title: 'Data subject requests',
    holds: 'Requests received and their deadlines, measured against the policy window.',
  },
  {
    title: 'Personal data breaches',
    holds: 'Breaches recorded in the period and the notification duty each carries.',
  },
  {
    title: 'Retention, legal holds and disposals',
    holds: 'The schedule, the holds that stop it, and what was disposed of.',
  },
] as const;

const contentsBlock = (): PdfBlock => ({
  stack: [
    { text: 'Contents', style: 'section' },
    {
      table: {
        widths: [24, 190, CONTENT_WIDTH - 214],
        body: SECTIONS.map((section, index) => [
          { text: String(index + 1), style: 'tdNumber' },
          { text: section.title, style: 'td', bold: true },
          { text: section.holds, style: 'tdDetail' },
        ]),
      },
      layout: 'noBorders',
    },
    {
      text: 'Sections are numbered as the document prints them; the tables run on until a period holds more records than one document lists.',
      style: 'note',
    },
  ],
});

/**
 * One section: its heading, its counts or empty sentence, then its table. `rows.rows.length === 0` always
 * prints `empty` — a blank page would read as nothing having happened.
 */
const section = (
  index: number,
  title: string,
  lead: PdfBlock[],
  table: PdfBlock | null,
  notes: readonly string[],
): PdfBlock => ({
  stack: [
    { text: `${index + 1}. ${title}`, style: 'section' },
    ...lead,
    ...(table === null ? [] : [table]),
    ...notes.map((text) => ({ text, style: 'note' })),
  ],
  pageBreak: index === 0 ? ('before' as const) : undefined,
});

/** The rows a section leaves out are counted, never dropped. */
const omittedNote = (rows: DpoRows<unknown>): string[] => {
  const notes: string[] = [];
  if (rows.notPrinted > 0) {
    notes.push(
      `${rows.notPrinted} more in-scope ${rows.notPrinted === 1 ? 'record is' : 'records are'} not listed here; the document prints the first ${rows.rows.length}.`,
    );
  }
  if (!rows.complete) {
    notes.push(
      'The register holds more records than this document reads, so the counts above are of the records it did read.',
    );
  }
  return notes;
};

const header = (titles: readonly string[]): PdfBlock[] =>
  titles.map((text) => ({ text, style: 'th' }));

const table = (widths: readonly number[], rows: readonly (readonly PdfBlock[])[]): PdfBlock => ({
  table: { headerRepeat: true, widths, body: rows },
  layout: 'lightHorizontalLines',
  margin: [0, 4, 0, 0],
});

/** A text column that never runs over: a table cell that wraps twice is a table nobody can read. */
const clipped = (value: string | null, length = 90): string => {
  if (value === null || value.length === 0) return NOT_SET;
  const oneLine = value.replace(/\s+/g, ' ');
  return oneLine.length > length ? `${oneLine.slice(0, length - 1)}…` : oneLine;
};

const governanceSection = (data: ConsolidatedDpoData): PdfBlock => {
  const { governance } = data;
  const lead = [
    {
      text: `Current maturity ${withScale(governance.maturity.current, ' of 5')}, target ${withScale(governance.maturity.target, ' of 5')}, average gap ${withScale(governance.maturity.gap, ' levels')}.`,
      style: 'body',
    },
    {
      text: `Mean exposure score ${withScale(governance.exposure.mean, ' of 125')}${governance.exposure.band === null ? '' : `, band ${governance.exposure.band.label}`}.`,
      style: 'body',
    },
    {
      text: `${governance.exposure.mean.assessed} of ${governance.exposure.mean.applicable} counted subjects carry an exposure score.`,
      style: 'body',
    },
    {
      text: `Getting started: ${governance.gettingStarted.completed} of ${governance.gettingStarted.total} steps complete, derived from saved records.`,
      style: 'body',
    },
  ];
  const notes = [
    ...(governance.maturity.availability === 'ok'
      ? []
      : [
          `Maturity is not stated: the counted work carries no level (${governance.maturity.availability}).`,
        ]),
    ...(governance.exposure.availability === 'ok'
      ? []
      : [`Exposure is not stated: ${governance.exposure.availability}.`]),
  ];
  return section(0, SECTIONS[0]!.title, lead, null, notes);
};

const ropaSection = (data: ConsolidatedDpoData): PdfBlock => {
  const { monitor, rows } = data.ropa;
  if (monitor.availability === 'no_records') {
    return section(1, SECTIONS[1]!.title, [{ text: NO_RECORDS, style: 'body' }], null, [
      'No processing activity has been recorded, so there is nothing for article 30 to describe.',
    ]);
  }
  const lead = [
    {
      text: `${monitor.total} live activities. Reviews: ${monitor.overdue} overdue, ${monitor.dueSoon} due soon, ${monitor.onTrack} on track, ${monitor.notReviewed} with no due date.`,
      style: 'body',
    },
    {
      text: `Counted against ${monitor.asOf} (${data.timezone}).`,
      style: 'muted',
    },
  ];
  const body = rows.rows.map((row) => [
    {
      stack: [
        { text: row.name, style: 'td', bold: true },
        { text: clipped(row.purpose, 120), style: 'tdDetail' },
      ],
    },
    { text: row.businessUnitName ?? 'Whole organisation', style: 'td' },
    { text: row.classificationLevelName ?? NOT_SET, style: 'td' },
    { text: label(ROPA_STATUS_LABEL, row.status), style: 'td' },
    { text: clipped(row.retention, 40), style: 'td' },
    { text: reviewText(row.reviewState, row.nextReviewDate), style: 'td' },
  ]);
  return section(
    1,
    SECTIONS[1]!.title,
    lead,
    rows.rows.length === 0
      ? null
      : table(
          [124, 74, 66, 46, 70, 85],
          [header(['Activity', 'Unit', 'Class', 'Status', 'Retention', 'Review']), ...body],
        ),
    rows.rows.length === 0
      ? ['Every activity in the register is archived, so none is live in this period.']
      : [
          'The register is standing data: every live activity is in scope whatever the period, because it is active during it.',
          ...omittedNote(rows),
        ],
  );
};

const risksSection = (data: ConsolidatedDpoData): PdfBlock => {
  const { summary, rows } = data.risks;
  if (summary.availability === 'no_records' && rows.rows.length === 0) {
    return section(2, SECTIONS[2]!.title, [{ text: NO_RECORDS, style: 'body' }], null, [
      'The register holds no risk, so there is nothing to carry into a period.',
    ]);
  }
  const lead = [
    {
      text: `${summary.total} risks are not closed, of which ${summary.open} still need someone to act. Reviews: ${summary.reviews.overdue} overdue, ${summary.reviews.dueSoon} due soon, ${summary.reviews.notScheduled} with no date set.`,
      style: 'body',
    },
    {
      text: `Counted against ${summary.asOf} (${data.timezone}) on the residual factors.`,
      style: 'muted',
    },
  ];
  const body = rows.rows.map((row) => [
    {
      stack: [
        { text: row.title, style: 'td', bold: true },
        {
          text: [row.governanceAreaName, row.businessUnitName, row.frameworkCode]
            .filter((part): part is string => part !== null)
            .join(' · '),
          style: 'tdDetail',
        },
      ],
    },
    { text: label(RISK_STATUS_LABEL, row.status), style: 'td' },
    {
      text: row.residual.level ?? NOT_ASSESSED,
      style: 'tdBand',
      color: row.residual.level === null ? '#5b6069' : BAND_COLOR[row.residual.level],
    },
    { text: num(row.residual.score), style: 'tdNumber' },
    { text: row.identifiedOn ?? row.createdAt.slice(0, 10), style: 'td' },
    { text: reviewText(row.reviewState, row.reviewByDate), style: 'td' },
  ]);
  return section(
    2,
    SECTIONS[2]!.title,
    lead,
    rows.rows.length === 0
      ? null
      : table(
          [150, 62, 54, 40, 58, 97],
          [header(['Risk', 'Status', 'Band', 'Score', 'Identified', 'Review']), ...body],
        ),
    rows.rows.length === 0
      ? ['No risk was identified in the period and none was still carried at its end.']
      : [
          'A risk is in scope when it was identified in the period or is not closed.',
          ...omittedNote(rows),
        ],
  );
};

const lawfulBasisSection = (data: ConsolidatedDpoData): PdfBlock => {
  const rows = data.lawfulBasis;
  if (rows.rows.length === 0) {
    return section(3, SECTIONS[3]!.title, [{ text: NO_RECORDS, style: 'body' }], null, [
      'No lawful basis has been recorded, so no processing this document describes is justified by a stated basis.',
    ]);
  }
  const body = rows.rows.map((row) => [
    {
      stack: [
        { text: row.purpose, style: 'td', bold: true },
        { text: clipped(row.justification, 110), style: 'tdDetail' },
      ],
    },
    { text: row.basis, style: 'td' },
    { text: row.frameworkCode ?? 'Not tied to a control', style: 'td' },
    { text: row.processingActivityName ?? 'Not linked', style: 'td' },
    { text: label(BASIS_REVIEW_LABEL, row.reviewStatus), style: 'td' },
    { text: reviewText(row.reviewState, row.nextReviewDate), style: 'td' },
  ]);
  return section(
    3,
    SECTIONS[3]!.title,
    [
      {
        text: `${rows.rows.length} live bases. The basis column is the organisation's own record, not a legal opinion.`,
        style: 'body',
      },
    ],
    table(
      [130, 62, 68, 90, 56, 55],
      [header(['Purpose', 'Basis', 'Control', 'Activity', 'Review', 'Due']), ...body],
    ),
    [
      'The register is standing data: every basis that has not been archived is in scope whatever the period.',
      ...omittedNote(rows),
    ],
  );
};

const dsarSection = (data: ConsolidatedDpoData): PdfBlock => {
  const { sla, rows } = data.dsar;
  const lead =
    sla.state === 'not_configured'
      ? [
          {
            text: 'No response window is configured in Company Settings, so no request can be measured against a deadline.',
            style: 'body',
          },
        ]
      : sla.state === 'no_records'
        ? [{ text: `${NO_RECORDS} — the tracker holds no request to measure.`, style: 'body' }]
        : [
            {
              text:
                `${sla.records} requests measured against ${sla.windowDays ?? NOT_SET} days: ` +
                `${sla.withinSla} within, ${sla.breached} breached, ${sla.openPastDeadline} open past their deadline, ` +
                `${sla.openNotYetDue} not yet due.` +
                (sla.percentage === null ? '' : ` On-time rate ${sla.percentage}%.`),
              style: 'body',
            },
            { text: `Counted against ${sla.today} (${data.timezone}).`, style: 'muted' },
          ];
  if (rows.rows.length === 0) {
    return section(4, SECTIONS[4]!.title, lead, null, [
      'No request was received in the period and none was still open at its end.',
      DSAR_IDENTITY_NOTE,
    ]);
  }
  const body = rows.rows.map((row) => [
    { text: row.requestType.replace(/_/g, ' '), style: 'td', bold: true },
    { text: label(DSAR_STATUS_LABEL, row.status), style: 'td' },
    { text: row.receivedOn, style: 'td' },
    { text: row.dueOn ?? NOT_SET, style: 'td' },
    {
      text:
        row.completedOn ??
        (row.extensionCount > 0 ? `Open (${row.extensionCount} extended)` : 'Open'),
      style: 'td',
    },
    { text: row.businessUnitName ?? 'Whole organisation', style: 'td' },
  ]);
  return section(
    4,
    SECTIONS[4]!.title,
    lead,
    table(
      [92, 84, 58, 58, 78, 91],
      [header(['Request', 'Status', 'Received', 'Due', 'Closed', 'Unit']), ...body],
    ),
    [
      'A request is in scope when it was received in the period or was still open at its end.',
      DSAR_IDENTITY_NOTE,
      ...omittedNote(rows),
    ],
  );
};

const breachesSection = (data: ConsolidatedDpoData): PdfBlock => {
  const { summary, rows } = data.breaches;
  const lead = [
    {
      text:
        `${summary.open} breaches are not closed and ${summary.annualTotal} were detected in the organisation's current calendar year.` +
        (summary.notificationConfigured
          ? ` ${summary.overdue} notification duties are undecided past their configured date.`
          : ' No notification window is configured, so nothing can be counted late.'),
      style: 'body',
    },
    { text: `Counted against ${summary.today} (${data.timezone}).`, style: 'muted' },
  ];
  if (rows.rows.length === 0) {
    return section(5, SECTIONS[5]!.title, lead, null, [
      'No breach was recorded in the period and none was still open at its end.',
    ]);
  }
  const body = rows.rows.map((row) => [
    {
      stack: [
        { text: row.title, style: 'td', bold: true },
        { text: clipped(row.affectedData, 120), style: 'tdDetail' },
      ],
    },
    { text: label(BREACH_STATUS_LABEL, row.status), style: 'td' },
    { text: row.detectedOn, style: 'td' },
    {
      text: row.severity ?? NOT_ASSESSED,
      style: 'tdBand',
      color: row.severity === null ? '#5b6069' : BAND_COLOR[row.severity],
    },
    { text: num(row.affectedSubjectCount), style: 'tdNumber' },
    { text: label(NOTIFICATION_LABEL, row.notificationState), style: 'td' },
  ]);
  return section(
    5,
    SECTIONS[5]!.title,
    lead,
    table(
      [140, 62, 56, 50, 46, 107],
      [
        header(['Breach', 'Status', 'Detected', 'Severity', 'Subjects', 'Notification duty']),
        ...body,
      ],
    ),
    [
      'A breach is in scope when it was detected in the period or was not closed by its end.',
      ...omittedNote(rows),
    ],
  );
};

const retentionSection = (data: ConsolidatedDpoData): PdfBlock => {
  const { rules, holds, disposals } = data.retention;
  const blocks: PdfBlock[] = [
    { text: `${rules.rows.length} live retention rules.`, style: 'body' },
  ];
  if (rules.rows.length > 0) {
    blocks.push(
      table(
        [124, 76, 62, 74, 78, 47],
        [
          header(['Rule', 'Class', 'Days', 'Trigger', 'Disposal', 'Review']),
          ...rules.rows.map((row) => [
            {
              stack: [
                { text: row.name, style: 'td', bold: true },
                { text: clipped(row.dataCategory, 90), style: 'tdDetail' },
              ],
            },
            { text: row.classificationLevelName ?? NOT_SET, style: 'td' },
            { text: num(row.retentionPeriodDays), style: 'tdNumber' },
            { text: row.triggerEvent?.replace(/_/g, ' ') ?? NOT_SET, style: 'td' },
            { text: clipped(row.disposalMethod, 60), style: 'td' },
            { text: reviewText(row.reviewState, row.nextReviewDate), style: 'td' },
          ]),
        ],
      ),
    );
  } else {
    blocks.push({ text: NO_RECORDS, style: 'body' });
  }

  blocks.push({ text: 'Legal holds', style: 'sub' });
  blocks.push(
    holds.rows.length === 0
      ? { text: 'No hold covers a record in this period.', style: 'body' }
      : table(
          [130, 60, 200, 61],
          [
            header(['Rule', 'Placed', 'Reason', 'Released']),
            ...holds.rows.map((row) => [
              { text: row.ruleName, style: 'td', bold: true },
              { text: row.placedAt.slice(0, 10), style: 'td' },
              { text: clipped(row.reason, 160), style: 'td' },
              {
                text: row.releasedAt === null ? 'Still holding' : row.releasedAt.slice(0, 10),
                style: 'td',
              },
            ]),
          ],
        ),
  );

  blocks.push({ text: 'Disposals recorded in the period', style: 'sub' });
  blocks.push(
    disposals.rows.length === 0
      ? { text: 'None recorded.', style: 'body' }
      : table(
          [70, 150, 220, 21],
          [
            header(['Disposed', 'Rule', 'Note', 'Count']),
            ...disposals.rows.map((row) => [
              { text: row.disposedOn, style: 'td' },
              { text: row.ruleName, style: 'td', bold: true },
              { text: clipped(row.note, 200), style: 'td' },
              { text: num(row.itemCount), style: 'tdNumber' },
            ]),
          ],
        ),
  );

  return {
    stack: [
      { text: `7. ${SECTIONS[6]!.title}`, style: 'section' },
      ...blocks,
      ...[
        'A rule or hold is in scope when it was live during the period; a disposal is in scope by the date the organisation recorded it against it.',
        ...omittedNote(rules),
        ...omittedNote(holds),
        ...omittedNote(disposals),
      ].map((text) => ({ text, style: 'note' })),
    ],
  };
};

/** Builds the Consolidated DPO Report from the payloads the seven modules' own endpoints answer with. */
export function buildConsolidatedDpo(data: ConsolidatedDpoData): PdfDocument {
  const titleLine = `${consolidatedDpo.title}: ${data.organisationName}`;
  const footerLine =
    `Generated ${stampIn(data.timezone, data.generatedAt)} (${data.timezone}) · Report ${data.reportId} · ` +
    `Period ${periodText(data.window)} · Methodology ${methodologyLine(data.governance)}`;
  return {
    pageSize: 'A4',
    pageMargins: PAGE_MARGINS,
    info: {
      title: titleLine,
      author: data.organisationName,
      language: 'en',
    },
    header: (page) =>
      page === 1
        ? { text: '' }
        : {
            text: data.params.confidential ? `${titleLine} · ${CONFIDENTIAL_MARK}` : titleLine,
            style: 'runningHead',
          },
    footer: (page, pages) => ({
      stack: [
        {
          columns: [
            { text: footerLine, style: 'foot' },
            { text: `Page ${page} of ${pages}`, style: 'foot', margin: [0, 0, 42, 0] },
          ],
        },
        {
          text: 'Informative aid; not legal advice. Mappings do not establish legal equivalence.',
          style: 'footNote',
        },
      ],
    }),
    defaultStyle: { fontSize: 9 },
    styles: {
      kind: { fontSize: 8.5, characterSpacing: 0.6, color: '#5b6069' },
      title: { fontSize: 17, bold: true, margin: [0, 2, 0, 4] },
      marking: { fontSize: 9, bold: true, characterSpacing: 0.8, color: '#c62828' },
      section: { fontSize: 10.5, bold: true, margin: [0, 12, 0, 4] },
      sub: { fontSize: 9, bold: true, margin: [0, 8, 0, 2] },
      body: { color: '#20232a' },
      muted: { color: '#5b6069', fontSize: 8.5 },
      metaLabel: { fontSize: 8, color: '#5b6069', bold: true },
      metaValue: { fontSize: 8.5 },
      th: { fontSize: 8, bold: true, fillColor: '#eef0f3' },
      td: { fontSize: 8 },
      tdDetail: { fontSize: 7, color: '#5b6069' },
      tdNumber: { fontSize: 8, alignment: 'right' },
      tdBand: { fontSize: 8, bold: true },
      note: { fontSize: 8, italics: true, color: '#5b6069', margin: [0, 4, 0, 0] },
      runningHead: { fontSize: 7, color: '#5b6069', alignment: 'right', margin: [0, 0, 0, 8] },
      foot: { fontSize: 6.5, color: '#5b6069' },
      footNote: { fontSize: 6.5, italics: true, color: '#5b6069', margin: [0, 2, 0, 0] },
      disclaimer: { fontSize: 7.5, italics: true, color: '#5b6069' },
    },
    content: [
      { text: consolidatedDpo.title, style: 'kind' },
      { text: data.organisationName, style: 'title' },
      {
        text: "The organisation's privacy position for one period, drawn from the same records every screen reads.",
        style: 'muted',
      },
      markingBlock(data),
      { stack: [rule('#9aa0a8'), metaTable(data)], margin: [0, 8, 0, 0] },
      {
        stack: [
          { text: 'What this document counts', style: 'sub' },
          { text: INCLUSION_RULE, style: 'body' },
        ],
        margin: [0, 8, 0, 0],
      },
      contentsBlock(),
      governanceSection(data),
      ropaSection(data),
      risksSection(data),
      lawfulBasisSection(data),
      dsarSection(data),
      breachesSection(data),
      retentionSection(data),
      {
        stack: [
          rule(),
          { text: data.scoringDisclaimer, style: 'disclaimer', margin: [0, 6, 0, 0] },
        ],
        margin: [0, 14, 0, 0],
      },
    ],
  };
}
