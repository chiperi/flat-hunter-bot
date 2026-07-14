/** Text inputs that mean "no constraint / skip this field". */
const SKIP_WORDS = new Set([
  '-',
  '',
  'будь-яка',
  'будьяка',
  'будь яка',
  'пропустити',
  'пропуск',
  'skip',
  'any',
  'всі',
  'усі',
  'все',
  'не важливо',
  'неважливо',
]);

export interface ParsedRange {
  min?: number;
  max?: number;
}

/**
 * Parse a free-text range like:
 *   "5000-15000"  -> {min:5000, max:15000}
 *   "5 000-15 000"-> {min:5000, max:15000}   (spaces as separators tolerated)
 *   "від 5000"    -> {min:5000}
 *   "до 15000"    -> {max:15000}
 *   "-15000"      -> {max:15000}
 *   "5000-"       -> {min:5000}
 *   "5000"        -> {max:5000}               (lone number = upper bound / "до")
 *   "-" / "будь-яка" / "" -> {}               (no constraint)
 */
export function parseRange(text: string): ParsedRange {
  const original = (text ?? '').trim().toLowerCase();
  if (SKIP_WORDS.has(original)) return {};

  const s = original.replace(/\s+/g, '');
  const nums = (s.match(/\d+/g) ?? []).map((n) => Number.parseInt(n, 10)).filter(Number.isFinite);
  if (nums.length === 0) return {};

  if (nums.length >= 2) {
    let [min, max] = [nums[0], nums[1]];
    if (min > max) [min, max] = [max, min]; // tolerate reversed input
    return { min, max };
  }

  // Single number → a MAXIMUM ("до") by default: the quick-pick buttons are all
  // "до X" and a budget is normally an upper bound. Only an explicit "від X" or a
  // trailing dash ("5000-") makes it a minimum.
  const isMin = /від/.test(s) || /\d-$/.test(s);
  return isMin ? { min: nums[0] } : { max: nums[0] };
}

/** True when the text is an explicit "no constraint" (skip word / dash / empty). */
export function isNoConstraint(text: string): boolean {
  return SKIP_WORDS.has((text ?? '').trim().toLowerCase());
}
