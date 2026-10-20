import type { LawfulBasisKind } from '../../domain/registers/records.js';
import type { RopaActivityDto, RopaMonitorDto } from '../../ropa/ropa.dto.js';
import {
  CONTENT_WIDTH,
  PAGE_MARGINS,
  rule,
  type PdfBlock,
  type PdfDocument,
} from '../pdf-document.js';
import type { ReportTemplateDefinition } from './registry.js';

/**
 * The Record of Processing Activities PDF (article 30): the register as the screen lists it, one row per live
 * activity, each with the lawful bases that justify it and the data classification it carries.
 *
 * It reads through `RopaService`, so the counts on page one are the counts the RoPA page shows and a row here
 * cannot say something different about the same activity. Archived activities are not listed — the document is
 * the register as it stands, and the history stays readable in the product.
 */

/** The whole register takes no narrowing: it is the tenant's live activities as of the day it is drawn. */
export type RopaRegisterParams = Record<string, never>;

/** Everything the document renders. It is stored as the report's snapshot, so this IS the record. */
export interface RopaRegisterData {
  readonly reportId: string;
  readonly organisationName: string;
  readonly timezone: string;
  readonly generatedAt: Date;
  readonly monitor: RopaMonitorDto;
  readonly rows: readonly RopaActivityDto[];
  /** Live activities this document does not print: a long register is never cut without saying so. */
  readonly rowsOmitted: number;
  readonly scoringDisclaimer: string;
}

export const ropaRegister = {
  id: 'ropa_register',
  version: 1,
  title: 'Record of Processing Activities',
  description:
    'Every live processing activity with its lawful basis, data classification, data subjects, storage period and review state — the article 30 record as the register holds it.',
  generate: 'sync',
  params: [],
} as const satisfies ReportTemplateDefinition;

const NOT_SET = 'Not stated';

/** The six article 6(1) bases in the reader's words, with the sub-paragraph each one is. */
const BASIS_LABEL: Record<LawfulBasisKind, string> = {
  CONSENT: 'Consent — Art. 6(1)(a)',
  CONTRACT: 'Contract — Art. 6(1)(b)',
  LEGAL_OBLIGATION: 'Legal obligation — Art. 6(1)(c)',
  VITAL_INTERESTS: 'Vital interests — Art. 6(1)(d)',
  PUBLIC_TASK: 'Public task — Art. 6(1)(e)',
  LEGITIMATE_INTEREST: 'Legitimate interests — Art. 6(1)(f)',
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  ARCHIVED: 'Archived',
};

const REVIEW_LABEL: Record<string, string> = {
  not_reviewed: 'No due date',
  overdue: 'Overdue',
  due_soon: 'Due soon',
  ok: 'On track',
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

/** One line, shortened to what a table cell can hold: the full text stays in the product. */
const clipped = (value: string | null, length = 90): string => {
  if (value === null || value.length === 0) return NOT_SET;
  const oneLine = value.replace(/\s+/g, ' ');
  return oneLine.length > length ? `${oneLine.slice(0, length - 1)}…` : oneLine;
};

const basesOf = (row: RopaActivityDto): string =>
  row.lawfulBasisRecords.map((basis) => label(BASIS_LABEL, basis.basis)).join(' · ') || NOT_SET;

const reviewText = (row: RopaActivityDto): string =>
  row.nextReviewDate === null
    ? label(REVIEW_LABEL, row.reviewState)
    : `${label(REVIEW_LABEL, row.reviewState)} (${row.nextReviewDate})`;

const metaTable = (data: RopaRegisterData): PdfBlock => {
  const rows: readonly (readonly [string, string])[] = [
    ['Organisation', data.organisationName],
    ['Scope', 'Every live processing activity in the register'],
    ['Activities listed', `${data.rows.length} of ${data.monitor.total}`],
    ['Register as of', `${data.monitor.asOf} (${data.timezone})`],
    ['Generated', `${stampIn(data.timezone, data.generatedAt)} (${data.timezone})`],
    ['Report', data.reportId],
  ];
  return {
    table: {
      widths: [110, CONTENT_WIDTH - 110],
      body: rows.map(([key, value]) => [
        { text: key, style: 'metaLabel' },
        { text: value, style: 'metaValue' },
      ]),
    },
    layout: 'noBorders',
  };
};

/** The four figures the register page counts, in the same words, so the two never disagree. */
const countsBlock = (data: RopaRegisterData): PdfBlock => {
  const { monitor } = data;
  const lead =
    monitor.availability === 'no_records'
      ? 'The register holds no live processing activity, so there is nothing for article 30 to list.'
      : `${monitor.total} live activities: ${monitor.linkedToLawfulBasis} justified by a lawful basis record, ${monitor.linkedToClassification} given a data classification, ${monitor.unlinked} with neither.`;
  const measures: readonly (readonly [string, string])[] = [
    ['Total activities', String(monitor.total)],
    ['Linked to a lawful basis', String(monitor.linkedToLawfulBasis)],
    ['Linked to a data classification', String(monitor.linkedToClassification)],
    ['Linked to neither', String(monitor.unlinked)],
    [
      'Review',
      `${monitor.overdue} overdue, ${monitor.dueSoon} due soon, ${monitor.onTrack} on track, ${monitor.notReviewed} with no due date`,
    ],
  ];
  return {
    stack: [
      { text: 'The register at a glance', style: 'section' },
      { text: lead, style: 'body' },
      ...(monitor.availability === 'no_records'
        ? []
        : [
            {
              table: {
                headerRepeat: true,
                widths: [220, CONTENT_WIDTH - 220],
                body: [
                  [
                    { text: 'Measure', style: 'th' },
                    { text: 'Result', style: 'th' },
                  ],
                  ...measures.map(([key, value]) => [
                    { text: key, style: 'td' },
                    { text: value, style: 'td' },
                  ]),
                ],
              },
              layout: 'lightHorizontalLines',
            },
            ...(monitor.availability === 'not_configured'
              ? [
                  {
                    text: 'No activity in the register has an approved next review date, so the review line states nothing about whether the register is current.',
                    style: 'note',
                  },
                ]
              : []),
          ]),
    ],
  };
};

const activitiesTable = (data: RopaRegisterData): PdfBlock => {
  const header = [
    'Processing activity',
    'Business unit',
    'Lawful basis',
    'Data subjects',
    'Storage period',
    'Status',
    'Review',
  ].map((text) => ({ text, style: 'th' }));
  const body = data.rows.map((row) => [
    {
      stack: [
        { text: row.name, style: 'td', bold: true },
        { text: clipped(row.purpose, 110), style: 'tdDetail' },
      ],
    },
    { text: row.businessUnitName ?? 'Whole organisation', style: 'td' },
    { text: clipped(basesOf(row), 60), style: 'td' },
    { text: clipped(row.dataSubjects, 50), style: 'td' },
    {
      stack: [
        { text: clipped(row.retention, 40), style: 'td' },
        ...(row.retentionRuleName === null
          ? []
          : [{ text: `Rule: ${row.retentionRuleName}`, style: 'tdDetail' }]),
      ],
    },
    { text: label(STATUS_LABEL, row.status), style: 'td' },
    {
      stack: [
        { text: reviewText(row), style: 'td' },
        { text: `Class: ${row.classificationLevelName ?? NOT_SET}`, style: 'tdDetail' },
      ],
    },
  ]);
  return {
    stack: [
      { text: 'Processing activities', style: 'section' },
      {
        table: {
          headerRepeat: true,
          widths: [112, 58, 96, 66, 62, 44, 73],
          body: [header, ...body],
        },
        layout: 'lightHorizontalLines',
      },
      ...(data.rowsOmitted > 0
        ? [
            {
              text: `${data.rowsOmitted} more live activities are in the register and are not printed. Read them in the product.`,
              style: 'note',
            },
          ]
        : []),
      {
        text: 'A lawful basis is listed when a record in the Lawful Basis Register points at the activity; the record keeps its own review state there. Blank cells are questions the organisation has not answered, not answers of "none".',
        style: 'note',
      },
    ],
  };
};

/** The article 30 columns the first table has no room for: who sees the data and under what protection. */
const disclosureTable = (data: RopaRegisterData): PdfBlock => {
  const header = [
    'Processing activity',
    'Personal data',
    'Recipients',
    'Processors',
    'Transfers',
  ].map((text) => ({ text, style: 'th' }));
  const body = data.rows.map((row) => [
    { text: row.name, style: 'td' },
    { text: clipped(row.personalDataCategories, 70), style: 'td' },
    { text: clipped(row.recipients, 70), style: 'td' },
    { text: clipped(row.processors, 60), style: 'td' },
    {
      stack: [
        { text: clipped(row.transferCountries ?? row.internationalTransfers, 50), style: 'td' },
        ...(row.securityMeasures === null
          ? []
          : [{ text: `Measures: ${clipped(row.securityMeasures, 50)}`, style: 'tdDetail' }]),
      ],
    },
  ]);
  return {
    stack: [
      { text: 'Categories, disclosures and transfers', style: 'section' },
      {
        table: {
          headerRepeat: true,
          widths: [112, 100, 100, 95, 104],
          body: [header, ...body],
        },
        layout: 'lightHorizontalLines',
      },
    ],
  };
};

/** Builds the RoPA register PDF from the same DTOs the register endpoints answer with. */
export function buildRopaRegister(data: RopaRegisterData): PdfDocument {
  const footerLine =
    `Generated ${stampIn(data.timezone, data.generatedAt)} (${data.timezone}) · Report ${data.reportId} · ` +
    `Register as of ${data.monitor.asOf} (${data.timezone})`;
  const empty = data.monitor.availability === 'no_records';
  return {
    pageSize: 'A4',
    pageMargins: PAGE_MARGINS,
    info: {
      title: `${ropaRegister.title}: ${data.organisationName}`,
      author: data.organisationName,
      language: 'en',
    },
    header: (page) =>
      page === 1
        ? { text: '' }
        : { text: `${ropaRegister.title}: ${data.organisationName}`, style: 'runningHead' },
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
      section: { fontSize: 10.5, bold: true, margin: [0, 12, 0, 4] },
      body: { color: '#20232a' },
      muted: { color: '#5b6069', fontSize: 8.5 },
      metaLabel: { fontSize: 8, color: '#5b6069', bold: true },
      metaValue: { fontSize: 8.5 },
      th: { fontSize: 8, bold: true, fillColor: '#eef0f3' },
      td: { fontSize: 8 },
      tdDetail: { fontSize: 7, color: '#5b6069' },
      note: { fontSize: 8, italics: true, color: '#5b6069', margin: [0, 4, 0, 0] },
      runningHead: { fontSize: 7, color: '#5b6069', alignment: 'right', margin: [0, 0, 0, 8] },
      foot: { fontSize: 6.5, color: '#5b6069' },
      footNote: { fontSize: 6.5, italics: true, color: '#5b6069', margin: [0, 2, 0, 0] },
      disclaimer: { fontSize: 7.5, italics: true, color: '#5b6069' },
    },
    content: [
      { text: ropaRegister.title, style: 'kind' },
      { text: data.organisationName, style: 'title' },
      {
        text: 'The article 30 record of processing activities, taken from the same register the product lists.',
        style: 'muted',
      },
      { stack: [rule('#9aa0a8'), metaTable(data)], margin: [0, 8, 0, 0] },
      countsBlock(data),
      ...(empty ? [] : [activitiesTable(data), disclosureTable(data)]),
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
