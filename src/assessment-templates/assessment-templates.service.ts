import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import type {
  AssessmentTemplateDetailDto,
  AssessmentTemplateDto,
} from './assessment-templates.dto.js';
import {
  AssessmentTemplatesRepository,
  type TemplateItemRecord,
  type TemplateRecord,
} from './assessment-templates.repository.js';

/** What a template is and is not (grc-domain: a topic list is not a legal requirement). */
export const TEMPLATE_DISCLAIMER =
  'A quick-start template is a list of programme topics to assess first. It is not a legal requirement, ' +
  'a certification or an interpretation of any law, and applying one leaves every rating unassessed.';

const notFound = () =>
  new AppException(
    ErrorCode.NotFound,
    HttpStatus.NOT_FOUND,
    'No such assessment template, or it has been withdrawn.',
  );

const toDto = (record: TemplateRecord & { itemCount: number }): AssessmentTemplateDto => ({
  id: record.id,
  code: record.code,
  templateVersion: record.templateVersion,
  name: record.name,
  description: record.description,
  itemCount: record.itemCount,
  provenance: record.provenance,
  verifiedBy: record.verifiedBy,
  verifiedAt: record.verifiedAt.toISOString(),
});

/**
 * The published quick-start templates (AC-GOV-01). They are platform reference data, frozen like a verified
 * framework version: a shipped row is never edited, a correction ships as a new edition under the same code.
 * Reading one is all this module does — creating items from it is the assessment's job.
 */
@Injectable()
export class AssessmentTemplatesService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly templates: AssessmentTemplatesRepository,
  ) {}

  list(): Promise<AssessmentTemplateDto[]> {
    return this.uow.run((tx) => this.templates.list(tx)).then((rows) => rows.map(toDto));
  }

  async get(id: string): Promise<AssessmentTemplateDetailDto> {
    const found = await this.uow.run(async (tx) => this.loadForApply(tx, id));
    if (!found) throw notFound();
    return {
      id: found.template.id,
      code: found.template.code,
      templateVersion: found.template.templateVersion,
      name: found.template.name,
      description: found.template.description,
      provenance: found.template.provenance,
      verifiedBy: found.template.verifiedBy,
      verifiedAt: found.template.verifiedAt.toISOString(),
      items: found.items.map((item) => ({ ...item })),
      disclaimer: TEMPLATE_DISCLAIMER,
    };
  }

  /** The template and its subjects, for the assessment module applying one. Null when the id is not published. */
  async loadForApply(
    tx: Tx,
    templateId: string,
  ): Promise<{ template: TemplateRecord; items: TemplateItemRecord[] } | null> {
    const template = await this.templates.findById(tx, templateId);
    if (!template) return null;
    return { template, items: await this.templates.items(tx, templateId) };
  }
}
