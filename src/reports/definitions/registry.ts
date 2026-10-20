import type { Permission } from '../../permissions/catalogue.js';
import type { ReportGenerationMode, ReportParamType } from '../reports.dto.js';
import { consolidatedDpo } from './consolidated-dpo.js';
import { executiveDashboard } from './executive-dashboard.js';
import { governanceAssessment } from './governance-assessment.js';

/**
 * The report catalogue (Phase 9a): one list of the definitions this build can render, so the history screen,
 * the generate form and the contract all read the same description of what a document is. Nothing here
 * restates a template's id, version or title — those live on the definition itself, and a second copy of a
 * count or a name is exactly how a document starts disagreeing with the screen it came from.
 */

/** One body field a template takes, described often enough for a client to build the form from the contract. */
export interface ReportParamDescriptor {
  readonly name: string;
  readonly type: ReportParamType;
  readonly required: boolean;
  readonly description: string;
  /** The accepted values, when `type` is `enum`. */
  readonly values?: readonly string[];
  /** The value used when the field is omitted, as the text the form shows. */
  readonly default?: string;
}

/** The metadata every template carries: enough to name it, version it and ask for it. */
export interface ReportTemplateDefinition {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  /** What the document is for, in the reader's words: the sentence under a template's name. */
  readonly description: string;
  /** `sync` renders inside the request; `async` queues a job and answers 202 with a PENDING record. */
  readonly generate: ReportGenerationMode;
  readonly params: readonly ReportParamDescriptor[];
}

/**
 * The permissions the report routes ask for, declared once. The controller's `@RequirePermission` and the
 * catalogue's `permission` field both read these, so a template cannot advertise a document the guard would
 * refuse.
 */
export const REPORT_PERMISSIONS = {
  view: 'reports.view',
  export: 'reports.export',
} as const satisfies Record<string, Permission>;

/** Everything the build can render today, in the order the generate screen lists it. */
export const REPORT_TEMPLATES: readonly ReportTemplateDefinition[] = [
  governanceAssessment,
  executiveDashboard,
  consolidatedDpo,
];

export const templateOf = (id: string): ReportTemplateDefinition | undefined =>
  REPORT_TEMPLATES.find((template) => template.id === id);

/**
 * Templates a later phase writes. They are named rather than left out so a client can say which phase
 * brings them: an absent entry reads as a bug in the product, an announced one reads as a plan.
 */
export const PLANNED_REPORT_TEMPLATES = [
  {
    id: 'training_certificate',
    title: 'Training Certificate',
    phase: '9b',
  },
  {
    id: 'ai_risk_assessment',
    title: 'AI Risk Assessment',
    phase: '10',
  },
] as const;
