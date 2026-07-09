import {
  parseRange,
  parseOwnerChoice,
  parseOptionalText,
  OWNER_ONLY_LABEL,
  INCLUDE_ALL_LABEL,
} from './parsing.util';

describe('parseRange', () => {
  it.each([
    ['5000-15000', { min: 5000, max: 15000 }],
    ['від 5000 до 15000', { min: 5000, max: 15000 }],
    ['від 5 000 до 15 000', { min: 5000, max: 15000 }],
    ['до 15000', { max: 15000 }],
    ['від 5000', { min: 5000 }],
    ['-15000', { max: 15000 }],
    ['5000-', { min: 5000 }],
    ['5000', { max: 5000 }], // lone number = "до" (upper bound)
    ['80000', { max: 80000 }],
    ['15000-5000', { min: 5000, max: 15000 }], // reversed → swapped
    ['30–60', { min: 30, max: 60 }], // en-dash
  ])('parses %s', (input, expected) => {
    expect(parseRange(input)).toEqual(expected);
  });

  it.each(['-', '', 'будь-яка', 'пропустити', 'skip', 'не важливо'])(
    'treats %s as no constraint',
    (input) => {
      expect(parseRange(input)).toEqual({});
    },
  );

  it('handles null/undefined input', () => {
    expect(parseRange(undefined as unknown as string)).toEqual({});
  });

  it('returns {} when there are no digits', () => {
    expect(parseRange('abc')).toEqual({});
  });
});

describe('parseOwnerChoice', () => {
  it.each([OWNER_ONLY_LABEL, 'Тільки власники', 'так', 'yes', '1', 'y'])(
    'returns true for %s',
    (input) => {
      expect(parseOwnerChoice(input)).toBe(true);
    },
  );

  it.each([INCLUDE_ALL_LABEL, 'усі', 'з ріелторами', 'ні', 'no', '2', 'n', 'агент'])(
    'returns false for %s',
    (input) => {
      expect(parseOwnerChoice(input)).toBe(false);
    },
  );

  it.each(['', 'щось геть інше', 'maybe'])('returns null for unrecognized %s', (input) => {
    expect(parseOwnerChoice(input)).toBeNull();
  });
});

describe('parseOptionalText', () => {
  it('returns trimmed text', () => {
    expect(parseOptionalText('  Центр ')).toBe('Центр');
  });
  it.each(['', '-', 'будь-яка', 'skip'])('returns undefined for %s', (input) => {
    expect(parseOptionalText(input)).toBeUndefined();
  });
});
