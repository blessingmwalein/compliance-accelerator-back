import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';

export interface TemplateRecord {
  id: string;
  code: string;
  templateVersion: number;
  name: string;
  description: string | null;
  provenance: string;
  verifiedBy: string;
  verifiedAt: Date;
}

export interface TemplateItemRecord {
  orderIndex: number;
  areaName: string;
  areaReference: string | null;
}

const SELECT = {
  id: true,
  code: true,
  templateVersion: true,
  name: true,
  description: true,
  provenance: true,
  verifiedBy: true,
  verifiedAt: true,
} as const;

/**
 * The published quick-start templates: global reference data, like a verified framework version. There is no
 * `organisation_id` here and the runtime role cannot write these tables, so nothing a tenant does can change
 * what a template says.
 */
@Injectable()
export class AssessmentTemplatesRepository {
  /** Every published template, newest edition of each code first, with its item count. */
  list(tx: Tx): Promise<(TemplateRecord & { itemCount: number })[]> {
    return tx.assessmentTemplate
      .findMany({
        orderBy: [{ code: 'asc' }, { templateVersion: 'desc' }],
        select: { ...SELECT, _count: { select: { items: true } } },
      })
      .then((rows) =>
        rows.map((row) => ({ ...row, itemCount: row._count.items })).filter(onlyLatestPerCode),
      );
  }

  findById(tx: Tx, id: string): Promise<TemplateRecord | null> {
    return tx.assessmentTemplate.findFirst({ where: { id }, select: SELECT });
  }

  /** The subjects of one template, in the template's own order. */
  items(tx: Tx, templateId: string): Promise<TemplateItemRecord[]> {
    return tx.assessmentTemplateItem.findMany({
      where: { templateId },
      orderBy: { orderIndex: 'asc' },
      select: { orderIndex: true, areaName: true, areaReference: true },
    });
  }
}

/** The list shows one row per code: the highest edition. Older editions stay readable by id. */
function onlyLatestPerCode(
  row: TemplateRecord & { itemCount: number },
  index: number,
  rows: (TemplateRecord & { itemCount: number })[],
): boolean {
  const previous = rows[index - 1];
  return previous === undefined || previous.code !== row.code;
}
