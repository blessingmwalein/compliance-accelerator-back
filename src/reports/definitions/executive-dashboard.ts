import type { MeasuredDto } from '../../assessments/assessments.dto.js';
import type {
  DashboardFrameworksDto,
  DashboardGapAnalysisDto,
  DashboardStatusValue,
  DashboardSummaryDto,
  DashboardTopRisksDto,
} from '../../dashboard/dashboard.dto.js';
import type { RiskLevel } from '../../domain/scoring/methodologies.js';
import { horizontalBars, type BarDatum } from '../charts/bars.js';
import {
  CONTENT_WIDTH,
  PAGE_MARGINS,
  rule,
  type PdfBlock,
  type PdfDocument,
} from '../pdf-document.js';
import type { ReportTemplateDefinition } from './registry.js';

/**
 * The Executive Dashboard PDF (Phase 8): the one-page summary an executive asks for.
 *
 * It renders the four dashboard payloads and nothing else. The sections whose counts belong to another
 * module (the DSAR SLA, open breaches, the RoPA monitor, the priority matrix) are read live from those
 * endpoints on the screen and are the Consolidated DPO Report's work (Phase 9a); drawing them here would
 * put a second copy of each number in the product.
 */

/** The organisation-wide document takes no narrowing: it is the whole tenant, as of the day it is read. */
export type ExecutiveDashboardParams = Record<string, never>;

/** Everything the document renders. It is stored as the report's snapshot, so this IS the record. */
export interface ExecutiveDashboardData {
  readonly reportId: string;
  readonly organisationName: string;
  readonly generatedAt: Date;
  readonly summary: DashboardSummaryDto;
  readonly frameworks: DashboardFrameworksDto;
  readonly gaps: DashboardGapAnalysisDto;
  readonly top: DashboardTopRisksDto;
  readonly scoringDisclaimer: string;
}

/**
 * One definition per template (skill: reports-and-documents). The permission it needs is NOT declared here:
 * the handler's `@RequirePermission` is the single source of truth.
 */
export const executiveDashboard = {
  id: 'executive_dashboard',
  version: 1,
  title: 'Executive Dashboard',
  description:
    "The organisation's position as of the day it is drawn: maturity, exposure, framework coverage, gaps and the highest-exposure risks.",
  generate: 'sync',
  params: [],
} as const satisfies ReportTemplateDefinition;

const NOT_ASSESSED = 'Not assessed';

/** The sentence a section with nothing to draw carries, when the payload gives no message of its own. */
const NO_FRAMEWORKS =
  'No framework is applicable yet. Choose them in Company Settings to see coverage and comparison.';

/** The band colours the risk register and the assessment PDF already use, so one colour means one band. */
const BAND_COLOR: Record<RiskLevel, string> = {
  LOW: '#2e7d32',
  MEDIUM: '#b28704',
  HIGH: '#e65100',
  CRITICAL: '#c62828',
};

/**
 * The verdict words. `compliant` is never printed: on its own it reads as a legal claim, while the metric
 * only says every assessed subject already reaches its own target.
 */
const STATUS_WORD: Record<DashboardStatusValue, string> = {
  compliant: 'Meets target',
  in_progress: 'In progress',
  needs_attention: 'Needs attention',
};

/** What each availability word means in the reader's language: an absent figure is explained, never guessed. */
const AVAILABILITY_SENTENCE: Record<string, string> = {
  no_records:
    'Nothing has been submitted or approved yet, so there are no records to measure against.',
  not_assessed:
    'The submitted work carries no maturity level or exposure score, so no figure can be stated.',
  not_configured:
    'No framework is applicable yet. Choose them in Company Settings to see coverage and comparison.',
  unable_to_calculate:
    'The counted cycles were scored under more than one methodology, and two band sets do not make one average.',
};

const availabilitySentence = (availability: string): string | null =>
  availability === 'ok' ? null : (AVAILABILITY_SENTENCE[availability] ?? null);

/** Generated-at is stamped in the organisation's own zone, as every report this product writes. */
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

/** The band colour of a status word, so a table column reads the same as the chart beside it. */
const bandColorOf = (status: DashboardStatusValue | null): string =>
  status === 'needs_attention'
    ? BAND_COLOR.HIGH
    : status === 'in_progress'
      ? BAND_COLOR.MEDIUM
      : BAND_COLOR.LOW;

/** A value with the coverage it came from: how many subjects were rated is part of the number. */
const measuredText = (measured: MeasuredDto, suffix = ''): string =>
  measured.value === null
    ? `${NOT_ASSESSED} (${measured.applicable} in scope)`
    : `${measured.value}${suffix} — ${measured.assessed} of ${measured.applicable} rated`;

const shortMeasured = (measured: MeasuredDto): string =>
  measured.value === null ? NOT_ASSESSED : String(measured.value);

const statusBlock = (status: DashboardStatusValue | null): PdfBlock[] =>
  status === null
    ? []
    : [{ text: `Position: ${STATUS_WORD[status]}`, style: 'body', margin: [0, 3, 0, 0] }];

const availabilityBlock = (availability: string): PdfBlock[] => {
  const sentence = availabilitySentence(availability);
  return sentence === null ? [] : [{ text: sentence, style: 'note', margin: [0, 4, 0, 0] }];
};

const methodologyLine = (summary: DashboardSummaryDto): string => {
  const list = summary.exposure.methodologies;
  if (list.length === 0) return 'No scored cycle';
  return list.map((item) => `${item.id} v${item.version}`).join(' · ');
};

const metaTable = (data: ExecutiveDashboardData): PdfBlock => {
  const { summary } = data;
  const rows: readonly (readonly [string, string])[] = [
    ['Organisation', data.organisationName],
    ['Scope', 'The whole organisation'],
    ['Position as of', `${summary.asOf} (${summary.timezone})`],
    ['Counted work', 'The newest submitted or approved cycle per subject'],
    ['Methodology', methodologyLine(summary)],
    [
      'Exposure band',
      summary.exposure.band === null
        ? NOT_ASSESSED
        : `${summary.exposure.band.label} (${summary.exposure.band.min}-${summary.exposure.band.max})`,
    ],
    ['Gap highlighted at', `${summary.gapHighlightLevels} levels`],
    ['Generated', `${stampIn(summary.timezone, data.generatedAt)} (${summary.timezone})`],
    ['Report', data.reportId],
  ];
  return {
    table: {
      widths: [118, CONTENT_WIDTH - 118],
      body: rows.map(([label, value]) => [
        { text: label, style: 'metaLabel' },
        { text: value, style: 'metaValue' },
      ]),
    },
    layout: 'noBorders',
  };
};

/** The six steps, in the server's own order, with the state the saved records show. */
const gettingStartedBlock = (data: ExecutiveDashboardData): PdfBlock => {
  const { gettingStarted } = data.summary;
  return {
    stack: [
      { text: 'Getting started', style: 'section' },
      {
        text: `${gettingStarted.completed} of ${gettingStarted.total} steps complete. Each one is derived from saved records, never from a ticked box.`,
        style: 'body',
      },
      {
        ul: gettingStarted.steps.map((step) => ({
          stack: [
            {
              text: `${step.done ? 'Done' : 'Not yet'} — ${step.title}`,
              style: 'td',
              bold: true,
            },
            { text: step.description, style: 'tdDetail' },
          ],
        })),
        margin: [0, 4, 0, 0],
      },
    ],
  };
};

const maturityBlock = (data: ExecutiveDashboardData): PdfBlock => {
  const { maturity } = data.summary;
  return {
    stack: [
      { text: 'Overall maturity', style: 'section' },
      { text: `Current: ${measuredText(maturity.current, ' of 5')}`, style: 'body' },
      { text: `Target: ${measuredText(maturity.target, ' of 5')}`, style: 'body' },
      { text: `Average gap: ${measuredText(maturity.gap, ' levels')}`, style: 'body' },
      ...statusBlock(maturity.status),
      ...availabilityBlock(maturity.availability),
    ],
  };
};

/** The exposure distribution of the counted subjects, in the same colours as the register. */
const exposureBlock = (data: ExecutiveDashboardData): PdfBlock => {
  const { exposure } = data.summary;
  const blocks: PdfBlock[] = [
    { text: `Mean exposure score: ${measuredText(exposure.mean, ' of 125')}`, style: 'body' },
    {
      text:
        exposure.band === null
          ? `Band: ${NOT_ASSESSED}`
          : `Band of the mean: ${exposure.band.label} (${exposure.band.min}-${exposure.band.max})`,
      style: 'body',
    },
  ];
  if (exposure.byRiskLevel === null) {
    return {
      stack: [
        { text: 'Risk exposure', style: 'section' },
        ...blocks,
        ...statusBlock(exposure.status),
        ...availabilityBlock(exposure.availability),
      ],
    };
  }
  const levels = Object.keys(exposure.byRiskLevel) as RiskLevel[];
  const bars: BarDatum[] = levels.map((level) => ({
    label: level,
    value: exposure.byRiskLevel?.[level] ?? 0,
    color: BAND_COLOR[level],
  }));
  const unmeasured = exposure.mean.applicable - exposure.mean.assessed;
  return {
    stack: [
      { text: 'Risk exposure', style: 'section' },
      ...blocks,
      ...statusBlock(exposure.status),
      ...availabilityBlock(exposure.availability),
      {
        columns: [
          { width: CONTENT_WIDTH - 150, svg: horizontalBars(bars, { width: CONTENT_WIDTH - 150 }) },
          {
            width: 150,
            table: {
              widths: [110, 40],
              body: bars.map((bar) => [
                { text: bar.label, fontSize: 8, color: bar.color },
                { text: String(bar.value), style: 'tdNumber' },
              ]),
            },
            layout: 'noBorders',
          },
        ],
        margin: [0, 6, 0, 0],
      },
      ...(unmeasured > 0
        ? [
            {
              text: `${unmeasured} of ${exposure.mean.applicable} counted subjects carry no exposure score and are in no band.`,
              style: 'note',
            },
          ]
        : []),
    ],
  };
};

/** Coverage and maturity per framework: the table the bar, radar and compliance cards all read from. */
const frameworksBlock = (data: ExecutiveDashboardData): PdfBlock => {
  const { frameworks } = data;
  if (frameworks.frameworks.length === 0) {
    return {
      stack: [
        { text: 'Framework coverage', style: 'section' },
        {
          text: frameworks.message ?? NO_FRAMEWORKS,
          style: 'body',
        },
      ],
    };
  }
  const header = [
    'Framework',
    'Controls',
    'In scope',
    'Rated',
    'Current',
    'Target',
    'Gap',
    'Status',
    'Open findings',
  ].map((text) => ({ text, style: 'th' }));
  const body = frameworks.frameworks.map((row) => [
    {
      stack: [
        { text: row.code, style: 'td', bold: true },
        { text: row.name, style: 'tdDetail' },
      ],
    },
    {
      text: row.catalogueControls === null ? NOT_ASSESSED : String(row.catalogueControls),
      style: 'tdNumber',
    },
    { text: String(row.inScope), style: 'tdNumber' },
    { text: `${row.rated}/${row.inScope}`, style: 'tdNumber' },
    { text: shortMeasured(row.current), style: 'tdNumber' },
    { text: shortMeasured(row.target), style: 'tdNumber' },
    { text: shortMeasured(row.gap), style: 'tdNumber' },
    {
      text: row.status === null ? NOT_ASSESSED : STATUS_WORD[row.status],
      style: 'td',
      color: row.availability === 'ok' ? bandColorOf(row.status) : '#5b6069',
    },
    { text: String(row.outstandingFindings), style: 'tdNumber' },
  ]);
  return {
    stack: [
      { text: 'Framework coverage', style: 'section' },
      {
        table: {
          headerRepeat: true,
          widths: [118, 52, 46, 40, 46, 46, 34, 66, 63],
          body: [header, ...body],
        },
        layout: 'lightHorizontalLines',
      },
      {
        text: 'Controls is what the loaded version of the framework holds. The platform does not decide which of them apply to your organisation: In scope does.',
        style: 'note',
      },
    ],
  };
};

/** Each governance area's distance from its target; the highlighted rows are the ones to look at first. */
const gapBlock = (data: ExecutiveDashboardData): PdfBlock => {
  const { gaps } = data;
  if (gaps.rows.length === 0) {
    return {
      stack: [
        { text: 'Gap analysis', style: 'section' },
        {
          text: 'No governance area has both a current and a target level in the counted work, so no gap can be stated.',
          style: 'body',
        },
      ],
    };
  }
  const header = [
    'Governance area',
    'Subjects',
    'Current',
    'Target',
    'Gap',
    'Exposure',
    'Status',
  ].map((text) => ({ text, style: 'th' }));
  const body = gaps.rows.map((row) => [
    { text: row.areaName, style: 'td', bold: row.highlight },
    { text: String(row.items), style: 'tdNumber' },
    { text: shortMeasured(row.current), style: 'tdNumber' },
    { text: shortMeasured(row.target), style: 'tdNumber' },
    { text: shortMeasured(row.gap), style: 'tdNumber' },
    { text: shortMeasured(row.exposure), style: 'tdNumber' },
    {
      text: row.highlight
        ? `Look here (${gaps.highlightAt}+ levels)`
        : row.status === null
          ? NOT_ASSESSED
          : STATUS_WORD[row.status],
      style: 'td',
    },
  ]);
  return {
    stack: [
      { text: 'Gap analysis', style: 'section' },
      ...availabilityBlock(gaps.availability),
      {
        table: {
          headerRepeat: true,
          widths: [160, 48, 50, 50, 42, 55, 106],
          body: [header, ...body],
        },
        layout: 'lightHorizontalLines',
      },
      {
        text: `A gap of ${gaps.highlightAt} levels or more is the same threshold the screen highlights.`,
        style: 'note',
      },
    ],
  };
};

/** `risk.top`: the carried risks with the most exposure, each with who owns it and what is owed. */
const topRisksBlock = (data: ExecutiveDashboardData): PdfBlock => {
  const { top } = data;
  if (top.items.length === 0) {
    return {
      stack: [
        { text: `Highest exposure risks (${top.basis})`, style: 'section' },
        {
          text:
            top.availability === 'no_records'
              ? 'The register holds no risk that is still carried, so there is nothing to rank.'
              : 'No risk reaches the ranking.',
          style: 'body',
        },
      ],
    };
  }
  const header = ['Risk', 'Owner', 'Score', 'Band', 'L × S', 'Review by', 'Work in progress'].map(
    (text) => ({ text, style: 'th' }),
  );
  const body = top.items.map((row) => [
    {
      stack: [
        { text: row.title, style: 'td' },
        {
          text: [row.governanceAreaName, row.businessUnitName, row.frameworkCode]
            .filter((part): part is string => part !== null)
            .join(' · '),
          style: 'tdDetail',
        },
      ],
    },
    { text: row.ownerName ?? 'Not assigned', style: 'td' },
    { text: row.score === null ? NOT_ASSESSED : String(row.score), style: 'tdNumber' },
    {
      text: row.level ?? NOT_ASSESSED,
      style: 'tdBand',
      color: row.level === null ? '#5b6069' : BAND_COLOR[row.level],
    },
    {
      text:
        row.likelihood === null || row.severity === null
          ? NOT_ASSESSED
          : `${row.likelihood} × ${row.severity}`,
      style: 'tdNumber',
    },
    { text: row.reviewByDate ?? 'Not scheduled', style: 'td' },
    {
      stack: [
        { text: row.task?.title ?? 'No task', style: 'td' },
        ...(row.task
          ? [
              {
                text: `${row.task.priority}, due ${row.task.dueDate ?? 'not set'}`,
                style: 'tdDetail',
              },
            ]
          : []),
      ],
    },
  ]);
  return {
    stack: [
      { text: `Highest exposure risks (${top.basis})`, style: 'section' },
      {
        table: {
          headerRepeat: true,
          widths: [150, 62, 38, 52, 46, 50, 113],
          body: [header, ...body],
        },
        layout: 'lightHorizontalLines',
      },
      {
        text:
          `The ${top.basis} factors the register itself stores, ranked over the ${top.limit} highest. ` +
          (top.unscored > 0
            ? `${top.unscored} carried risk${top.unscored === 1 ? ' is' : 's are'} not scored on this basis and are not listed.`
            : 'Every carried risk is scored on this basis.'),
        style: 'note',
      },
    ],
  };
};

/** Builds the Executive Dashboard PDF from the same DTOs the dashboard endpoints answer with. */
export function buildExecutiveDashboard(data: ExecutiveDashboardData): PdfDocument {
  const { summary } = data;
  const footerLine =
    `Generated ${stampIn(summary.timezone, data.generatedAt)} (${summary.timezone}) · Report ${data.reportId} · ` +
    `Position as of ${summary.asOf} (${summary.timezone}) · Methodology ${methodologyLine(summary)}`;
  return {
    pageSize: 'A4',
    pageMargins: PAGE_MARGINS,
    info: {
      title: `${executiveDashboard.title}: ${data.organisationName}`,
      author: data.organisationName,
      language: 'en',
    },
    header: (page) =>
      page === 1
        ? { text: '' }
        : { text: `${executiveDashboard.title}: ${data.organisationName}`, style: 'runningHead' },
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
      tdNumber: { fontSize: 8, alignment: 'right' },
      tdBand: { fontSize: 8, bold: true },
      note: { fontSize: 8, italics: true, color: '#5b6069', margin: [0, 4, 0, 0] },
      runningHead: { fontSize: 7, color: '#5b6069', alignment: 'right', margin: [0, 0, 0, 8] },
      foot: { fontSize: 6.5, color: '#5b6069' },
      footNote: { fontSize: 6.5, italics: true, color: '#5b6069', margin: [0, 2, 0, 0] },
      disclaimer: { fontSize: 7.5, italics: true, color: '#5b6069' },
    },
    content: [
      { text: executiveDashboard.title, style: 'kind' },
      { text: data.organisationName, style: 'title' },
      {
        text: "The organisation's compliance position as of the day this document was drawn, taken from the same figures the dashboard screen shows.",
        style: 'muted',
      },
      { stack: [rule('#9aa0a8'), metaTable(data)], margin: [0, 8, 0, 0] },
      gettingStartedBlock(data),
      maturityBlock(data),
      exposureBlock(data),
      topRisksBlock(data),
      gapBlock(data),
      frameworksBlock(data),
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
