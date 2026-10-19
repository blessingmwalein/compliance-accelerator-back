/**
 * pdfmake embeds the font's glyph outlines into the PDF and asks the family for one glyph per character.
 * The OFL family it ships (Roboto) carries the whole Latin range plus Greek, Cyrillic, `€`, `×`, `—`, `·`
 * and `…`, which is every character a report's own wording uses — but it carries no arrows and no dingbats,
 * and no other Latin text family has them either: a wider OFL font would not help, because `→` and `✓` live
 * in the Unicode blocks that Latin UI fonts omit.
 *
 * An unrepresentable character renders as nothing at all, so free text typed into the product (a finding, a
 * risk title, a member's name) can lose the one mark that made it read as satisfied or failed. That is a
 * silent change of meaning in a compliance document, so each such character is replaced with an ASCII
 * spelling of the same fact before the document is handed to pdfmake.
 */
const SUBSTITUTIONS: ReadonlyMap<string, string> = new Map([
  ['←', '<-'],
  ['↑', '(up)'],
  ['→', '->'],
  ['↓', '(down)'],
  ['⇐', '<='],
  ['⇒', '=>'],
  ['⟵', '<-'],
  ['⟶', '->'],
  // met: the mark a reviewer puts beside a control that holds
  ['✓', '[x]'],
  ['✔', '[x]'],
  ['☑', '[x]'],
  ['❑', '[ ]'],
  // not met, or not applicable
  ['✗', 'x'],
  ['✘', 'x'],
  ['☒', 'x'],
  ['☐', '[ ]'],
  // list and rating marks
  ['●', '-'],
  ['○', '-'],
  ['◐', '-'],
  ['★', '*'],
  ['☆', '*'],
  ['⚠', '!'],
  ['⛔', 'x'],
  ['👍', '(ok)'],
  ['👎', '(not ok)'],
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Every character the embedded family cannot draw, in the order a reader would meet them. Kept out of
 * `substitute` so a caller can name the risk instead of guessing it.
 */
export const unsupportedGlyphs = (): string[] => [...SUBSTITUTIONS.keys()];

/** One string, with each unrepresentable character replaced by its ASCII spelling. */
export function substitute(text: string): string {
  let out = '';
  for (const char of text) out += SUBSTITUTIONS.get(char) ?? char;
  return out;
}

/**
 * The whole document definition, walked. Strings are replaced; page callbacks (`header`, `footer`) are
 * wrapped, because pdfmake builds their blocks after this walk; numbers, booleans and style names are
 * left exactly as they are.
 */
export function substituteDeep<T>(value: T): T {
  if (typeof value === 'string') return substitute(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => substituteDeep(item)) as unknown as T;
  if (typeof value === 'function') {
    const build = value as (...args: unknown[]) => unknown;
    return ((...args: unknown[]) => substituteDeep(build(...args))) as unknown as T;
  }
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = substituteDeep(item);
    return copy as unknown as T;
  }
  return value;
}
