import type {
  AssessmentDto,
  AssessmentItemDto,
  AssessmentSummaryDto,
  MeasuredDto,
} from '../../assessments/assessments.dto.js';
import type { RiskLevel } from '../../domain/scoring/methodologies.js';
import { todayIn } from '../../domain/remediation/policy.js';
import { horizontalBars } from '../charts/bars.js';
import {
  CONTENT_WIDTH,
  PAGE_MARGINS,
  rule,
  type PdfBlock,
  type PdfDocument,
} from '../pdf-document.js';

/** What the caller asks a report to cover: one cycle, optionally narrowed to one unit and one framework. */
export interface GovernanceAssessmentParams {
  readonly assessmentId: string;
  readonly businessUnitId: string | null;
  readonly frameworkId: string | null;
}

/** Everything the document actually renders. It is stored as the report's snapshot, so this IS the record. */
export interface GovernanceAssessmentData {
  readonly reportId: string;
  readonly organisationName: string;
  readonly timezone: string;
  readonly generatedAt: Date;
  readonly assessment: AssessmentDto;
  readonly summary: AssessmentSummaryDto;
  readonly items: readonly AssessmentItemDto[];
  /** Items in scope this document does not list: a long table is never cut without saying so. */
  readonly itemsOmitted: number;
  /** The name of the filtered business unit, when the filter left any rows to read it from. */
  readonly unitName: string | null;
  /** The code of the filtered framework, when the filter left any rows to read it from. */
  readonly frameworkCode: string | null;
  readonly scoringDisclaimer: string;
}

/**
 * One definition per template (skill: reports-and-documents). The permission it needs is NOT declared here: the
 * handler's `@RequirePermission` is the single source of truth, and a second copy could only drift from it.
 */
export const governanceAssessment = {
  id: 'governance_assessment',
  version: 1,
  title: 'Governance Assessment',
} as const;

const NOT_ASSESSED = 'Not assessed';
const NO_RECORDS = 'No records';

const BAND_COLOR: Record<RiskLevel, string> = {
  LOW: '#2e7d32',
  MEDIUM: '#b28704',
  HIGH: '#e65100',
  CRITICAL: '#c62828',
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft — still being worked on',
  IN_REVIEW: 'Submitted for review',
  APPROVED: 'Approved',
  SUPERSEDED: 'Superseded by a later cycle',
};

const num = (value: number | null): string => (value === null ? NOT_ASSESSED : String(value));

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

/** A value with the coverage it came from: how many items were rated is part of the number, never hidden. */
const measuredText = (measured: MeasuredDto, suffix = ''): string =>
  measured.value === null
    ? `${NO_RECORDS} (${measured.applicable} in scope)`
    : `${measured.value}${suffix} — ${measured.assessed} of ${measured.applicable} rated`;

const subjectOf = (item: AssessmentItemDto): string =>
  item.governanceAreaName ?? item.requirementRef ?? 'Unnamed subject';

const subjectDetail = (item: AssessmentItemDto): string => {
  const parts: string[] = [];
  if (item.governanceAreaName && item.requirementRef) parts.push(item.requirementRef);
  if (item.frameworkCode) parts.push(item.frameworkCode);
  return parts.join(' · ');
};

const bandLabelOf = (assessment: AssessmentDto, level: RiskLevel | null): string =>
  level === null
    ? NOT_ASSESSED
    : (assessment.exposureBands.find((band) => band.key === level)?.label ?? level);

/** The filter that was asked for is named even when it selected no rows, so the scope line never lies. */
const scopeLine = (data: GovernanceAssessmentData, params: GovernanceAssessmentParams): string => {
  const unit =
    data.unitName ?? (params.businessUnitId === null ? 'All business units' : 'One business unit');
  const framework =
    data.frameworkCode ?? (params.frameworkId === null ? 'All frameworks' : 'One framework');
  return `${unit} · ${framework}`;
};

const metaTable = (
  data: GovernanceAssessmentData,
  params: GovernanceAssessmentParams,
): PdfBlock => {
  const { assessment } = data;
  const rows: readonly (readonly [string, string])[] = [
    ['Organisation', data.organisationName],
    ['Scope', scopeLine(data, params)],
    ['Assessment status', STATUS_LABEL[assessment.status] ?? assessment.status],
    [
      'Items in scope',
      data.itemsOmitted > 0
        ? `${data.summary.itemCount} in the assessment, ${data.items.length} listed here (${data.itemsOmitted} not printed)`
        : String(data.summary.itemCount),
    ],
    [
      'Methodology',
      `${assessment.methodology.id} v${assessment.methodology.version}: ${assessment.methodology.formula}`,
    ],
    [
      'Bands in force',
      assessment.exposureBands.map((band) => `${band.label} ${band.min}-${band.max}`).join(' · '),
    ],
    ['Generated', `${stampIn(data.timezone, data.generatedAt)} (${data.timezone})`],
    ['Report', data.reportId],
  ];
  return {
    table: {
      widths: [110, CONTENT_WIDTH - 110],
      body: rows.map(([label, value]) => [
        { text: label, style: 'metaLabel' },
        { text: value, style: 'metaValue' },
      ]),
    },
    layout: 'noBorders',
  };
};

const signOffBlock = (data: GovernanceAssessmentData): PdfBlock => {
  const { assessment } = data;
  const lines: string[] = [];
  if (assessment.approvedAt) {
    lines.push(`Approved ${todayIn(data.timezone, new Date(assessment.approvedAt))}.`);
  } else if (assessment.submittedAt) {
    lines.push(`Submitted for review ${todayIn(data.timezone, new Date(assessment.submittedAt))}.`);
  } else {
    lines.push('Not submitted and not approved: no reviewer has signed this cycle off.');
  }
  if (assessment.reviewComment) lines.push(`Reviewer comment: ${assessment.reviewComment}`);
  if (assessment.revisesAssessmentId) {
    lines.push(
      'This cycle revises an earlier one; the cycle it replaces stays on record unchanged.',
    );
  }
  return {
    stack: [
      { text: 'Sign-off', style: 'section' },
      { text: lines.join(' '), style: 'body' },
    ],
  };
};

const summaryBlock = (data: GovernanceAssessmentData): PdfBlock => {
  const { summary } = data;
  if (summary.itemCount === 0) {
    return {
      stack: [
        { text: 'Summary', style: 'section' },
        {
          text: 'No items in this scope: nothing was assessed, so there are no results to report.',
          style: 'body',
        },
      ],
    };
  }
  const rows: readonly (readonly [string, string])[] = [
    ['Average current maturity', measuredText(summary.averageMaturity, ' of 5')],
    ['Average maturity gap', measuredText(summary.averageGap, ' levels')],
    ['Average exposure score', measuredText(summary.averageExposure, ' of 125')],
    ['Rated High or Critical', measuredText(summary.highOrCritical, ' items')],
    ['Not rated yet', `${summary.notRated} of ${summary.itemCount}`],
  ];
  return {
    stack: [
      { text: 'Summary', style: 'section' },
      {
        table: {
          headerRepeat: true,
          widths: [220, CONTENT_WIDTH - 220],
          body: [
            [
              { text: 'Measure', style: 'th' },
              { text: 'Result', style: 'th' },
            ],
            ...rows.map(([label, value]) => [
              { text: label, style: 'td' },
              { text: value, style: 'td' },
            ]),
          ],
        },
        layout: 'lightHorizontalLines',
      },
    ],
  };
};

const distributionBlock = (data: GovernanceAssessmentData): PdfBlock => {
  const { summary } = data;
  const byRiskLevel = summary.byRiskLevel;
  const bars = (Object.keys(byRiskLevel) as RiskLevel[]).map((level) => ({
    label: bandLabelOf(data.assessment, level),
    value: byRiskLevel[level] ?? 0,
    color: BAND_COLOR[level],
  }));
  return {
    stack: [
      { text: 'Exposure distribution', style: 'section' },
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
      },
      // the counts alone are not enough: say what the chart is a chart of
      ...(summary.notRated > 0
        ? [
            {
              text: `${summary.notRated} of ${summary.itemCount} items are not rated and are in no band.`,
              style: 'note',
            },
          ]
        : []),
    ],
  };
};

const itemsTable = (data: GovernanceAssessmentData): PdfBlock => {
  const header = ['Subject', 'Business unit', 'Current', 'Target', 'Gap', 'Exposure', 'Band'].map(
    (text) => ({ text, style: 'th' }),
  );
  const body = data.items.map((item) => {
    const detail = subjectDetail(item);
    return [
      {
        stack: [
          { text: subjectOf(item), style: 'td' },
          ...(detail === '' ? [] : [{ text: detail, style: 'tdDetail' }]),
        ],
      },
      { text: item.businessUnitName ?? 'All the organisation', style: 'td' },
      { text: num(item.currentMaturity), style: 'tdNumber' },
      { text: num(item.targetMaturity), style: 'tdNumber' },
      { text: num(item.gap), style: 'tdNumber' },
      { text: num(item.exposure), style: 'tdNumber' },
      {
        text: bandLabelOf(data.assessment, item.riskLevel),
        style: 'tdBand',
        color: item.riskLevel === null ? '#5b6069' : BAND_COLOR[item.riskLevel],
      },
    ];
  });
  const blocks: PdfBlock[] = [
    {
      table: {
        headerRepeat: true,
        widths: [CONTENT_WIDTH - 254, 66, 34, 34, 28, 40, 52],
        body: [header, ...body],
      },
      layout: 'lightHorizontalLines',
    },
  ];
  if (data.itemsOmitted > 0) {
    blocks.push({
      text: `${data.itemsOmitted} more items are in this scope and are not printed. Read them in the assessment table.`,
      style: 'note',
    });
  }
  return { stack: [{ text: 'Assessed subjects', style: 'section' }, ...blocks] };
};

const findingsBlock = (data: GovernanceAssessmentData): PdfBlock => {
  const rows = data.items
    .filter((item) => item.findings !== null || item.rationale !== null)
    .map((item) => [
      { text: subjectOf(item), style: 'td' },
      {
        stack: [
          ...(item.findings === null ? [] : [{ text: item.findings, style: 'td' }]),
          ...(item.rationale === null
            ? []
            : [{ text: `Rationale: ${item.rationale}`, style: 'tdDetail' }]),
        ],
      },
    ]);
  if (rows.length === 0) {
    return {
      stack: [
        { text: 'Findings and rationale', style: 'section' },
        { text: 'None recorded for the items in this scope.', style: 'body' },
      ],
    };
  }
  return {
    stack: [
      { text: 'Findings and rationale', style: 'section' },
      {
        table: { headerRepeat: true, widths: [150, CONTENT_WIDTH - 150], body: rows },
        layout: 'lightHorizontalLines',
      },
    ],
  };
};

/** Builds the Governance Assessment PDF from the same DTOs the API answers with, so the two cannot differ. */
export function build(
  data: GovernanceAssessmentData,
  params: GovernanceAssessmentParams,
): PdfDocument {
  const { assessment } = data;
  const empty = data.summary.itemCount === 0;
  const footerLine =
    `Generated ${stampIn(data.timezone, data.generatedAt)} · Report ${data.reportId} · ` +
    `Methodology ${assessment.methodology.id} v${assessment.methodology.version}`;
  return {
    pageSize: 'A4',
    pageMargins: PAGE_MARGINS,
    info: {
      title: `${governanceAssessment.title}: ${assessment.title}`,
      author: data.organisationName,
      language: 'en',
    },
    header: (page) =>
      page === 1
        ? { text: '' }
        : { text: `${governanceAssessment.title}: ${assessment.title}`, style: 'runningHead' },
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
      { text: governanceAssessment.title, style: 'kind' },
      { text: assessment.title, style: 'title' },
      ...(assessment.description === null
        ? []
        : [{ text: assessment.description, style: 'muted' }]),
      { stack: [rule('#9aa0a8'), metaTable(data, params)], margin: [0, 8, 0, 0] },
      signOffBlock(data),
      summaryBlock(data),
      ...(empty ? [] : [distributionBlock(data), itemsTable(data), findingsBlock(data)]),
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
