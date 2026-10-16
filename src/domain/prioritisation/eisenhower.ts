/**
 * Eisenhower prioritisation, ruleset v1 (skill grc-domain). The answers are saved with the ruleset version;
 * urgency and importance are DERIVED from them (and from an authorised person's adjustment) every time, so a
 * quadrant is never stored without the criteria that produced it.
 *
 * The questions are the reference app's workflow descriptions, worded here; the thresholds in them (90 days,
 * 500 data subjects) are reference defaults, not legal rules.
 */

export const RULESET_VERSION = 1;

export const URGENCY_QUESTIONS = [
  {
    key: 'manual_handling',
    text: 'Is the work still done manually, or without a defined process?',
  },
  { key: 'no_controls', text: 'Are there no controls in place yet?' },
  {
    key: 'regulator_deadline',
    text: 'Is there a regulator or contractual deadline within the next 90 days?',
  },
  { key: 'active_breach', text: 'Is there an active or suspected breach linked to this?' },
  { key: 'third_party_access', text: 'Do third parties have access to the data involved?' },
] as const;

export const IMPORTANCE_QUESTIONS = [
  { key: 'sensitive_data', text: 'Does it involve sensitive or special-category data?' },
  { key: 'high_volume', text: 'Does it involve more than 500 data subjects?' },
  { key: 'cross_border', text: 'Does the data cross borders?' },
  { key: 'core_business', text: 'Is it core to how the business operates?' },
  { key: 'regulatory_obligation', text: 'Is it tied to a regulatory obligation?' },
] as const;

export type UrgencyKey = (typeof URGENCY_QUESTIONS)[number]['key'];
export type ImportanceKey = (typeof IMPORTANCE_QUESTIONS)[number]['key'];
export type QuestionKey = UrgencyKey | ImportanceKey;

export const QUESTION_KEYS: readonly QuestionKey[] = [
  ...URGENCY_QUESTIONS.map((question) => question.key),
  ...IMPORTANCE_QUESTIONS.map((question) => question.key),
];

/** `true` = Yes, `false` = No, a missing key = NOT ANSWERED (which is never the same as No). */
export type Answers = Partial<Record<QuestionKey, boolean>>;

export const QUADRANTS = ['DO_NOW', 'PLAN', 'DELEGATE', 'ELIMINATE'] as const;
export type Quadrant = (typeof QUADRANTS)[number];

/**
 * Yes to any question of the group makes it true; No to every question of the group makes it false;
 * anything else (no Yes, some unanswered) is unknown (null).
 */
function groupFlag(answers: Answers, keys: readonly QuestionKey[]): boolean | null {
  if (keys.some((key) => answers[key] === true)) return true;
  if (keys.every((key) => answers[key] === false)) return false;
  return null;
}

export interface Derived {
  urgent: boolean | null;
  important: boolean | null;
}

export function derive(answers: Answers): Derived {
  return {
    urgent: groupFlag(
      answers,
      URGENCY_QUESTIONS.map((question) => question.key),
    ),
    important: groupFlag(
      answers,
      IMPORTANCE_QUESTIONS.map((question) => question.key),
    ),
  };
}

export interface Adjustment {
  urgent: boolean | null;
  important: boolean | null;
}

export interface Effective extends Derived {
  quadrant: Quadrant | null;
  /** True when an adjustment decided urgency or importance. */
  adjusted: boolean;
}

/** The quadrant from the saved answers, with an adjustment (if any) taking precedence over a derived flag. */
export function classify(answers: Answers, adjustment: Adjustment | null): Effective {
  const derived = derive(answers);
  const urgent = adjustment?.urgent ?? derived.urgent;
  const important = adjustment?.important ?? derived.important;
  return {
    urgent,
    important,
    quadrant: quadrantOf(urgent, important),
    adjusted: adjustment?.urgent != null || adjustment?.important != null,
  };
}

/** No quadrant until BOTH flags are known: an unanswered questionnaire is not "Eliminate". */
export function quadrantOf(urgent: boolean | null, important: boolean | null): Quadrant | null {
  if (urgent === null || important === null) return null;
  if (urgent) return important ? 'DO_NOW' : 'DELEGATE';
  return important ? 'PLAN' : 'ELIMINATE';
}

export const QUADRANT_INFO: Readonly<
  Record<Quadrant, { label: string; purpose: string; defaultScheduling: string }>
> = {
  DO_NOW: {
    label: 'Do now',
    purpose: 'Urgent and important: deal with it straight away.',
    defaultScheduling: 'Start immediately',
  },
  PLAN: {
    label: 'Plan',
    purpose: 'Important but not urgent: schedule it before it becomes urgent.',
    defaultScheduling: 'Schedule within the planning window',
  },
  DELEGATE: {
    label: 'Delegate',
    purpose: 'Urgent but not important: hand it to the right owner.',
    defaultScheduling: 'Assign an owner now',
  },
  ELIMINATE: {
    label: 'Eliminate',
    purpose: 'Neither urgent nor important: review whether it is needed at all.',
    defaultScheduling: 'Review at the next cycle',
  },
};

/** Reference default for the Plan quadrant, in days (an organisation can change it). */
export const DEFAULT_PLAN_WINDOW = { minDays: 30, maxDays: 90 } as const;

/** Answers from untrusted JSON: only known keys with boolean values survive. */
export function cleanAnswers(raw: unknown): Answers {
  const result: Answers = {};
  if (typeof raw !== 'object' || raw === null) return result;
  for (const key of QUESTION_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'boolean') result[key] = value;
  }
  return result;
}
