import { parseRange, isNoConstraint } from './parsing.util';

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

describe('isNoConstraint', () => {
  it.each(['-', '', 'будь-яка', 'skip', 'не важливо'])('true for skip word %s', (t) => {
    expect(isNoConstraint(t)).toBe(true);
  });
  it.each(['5000', 'до 10', 'бла бла'])('false for %s', (t) => {
    expect(isNoConstraint(t)).toBe(false);
  });
});

