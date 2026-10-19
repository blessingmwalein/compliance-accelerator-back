/** One subject of a template: the area a new assessment item would be filed under. */
export class AssessmentTemplateItemDto {
  /** The position in the template (a stable, meaningful order). */
  orderIndex!: number;
  /** The area label. Applying reuses the organisation's active area with the same name. */
  areaName!: string;
  /** Optional free text about what the area covers, in the template's own words. */
  areaReference!: string | null;
}

/** A published quick-start template. The newest edition of each code is what the list shows. */
export class AssessmentTemplateDto {
  id!: string;
  /** The stable identity of the template; an edition has the same code and a higher `templateVersion`. */
  code!: string;
  templateVersion!: number;
  name!: string;
  description!: string | null;
  /** How many subjects it holds. */
  itemCount!: number;
  /** Where the topic list came from, and what it is not. */
  provenance!: string;
  /** The named person who checked the wording before it shipped. */
  verifiedBy!: string;
  /** ISO 8601 UTC instant of that check. */
  verifiedAt!: string;
}

/** A template with its subjects. */
export class AssessmentTemplateDetailDto {
  id!: string;
  code!: string;
  templateVersion!: number;
  name!: string;
  description!: string | null;
  provenance!: string;
  verifiedBy!: string;
  verifiedAt!: string;
  items!: AssessmentTemplateItemDto[];
  /**
   * A quick-start list of topics, not a legal requirement: applying it creates items whose maturity, target
   * and risk ratings stay unassessed until someone rates them.
   */
  disclaimer!: string;
}
