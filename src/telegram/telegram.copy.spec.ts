import { esc, describeProfile, WELCOME, HELP, NO_SEARCHES } from './telegram.copy';
import { SearchProfile } from '../search-profiles/search-profile.model';

const profile = (over: Partial<SearchProfile> = {}): SearchProfile => ({
  id: 'abc123',
  userId: 1,
  chatId: 1,
  name: 'Мій пошук',
  criteria: { city: 'Київ', ownerOnly: true },
  paused: false,
  primed: false,
  createdAt: 0,
  ...over,
});

describe('esc', () => {
  it('escapes HTML-significant characters', () => {
    expect(esc('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
  });
  it('escapes double quotes (used inside href="...")', () => {
    expect(esc('https://x.com/a?q="1"')).toBe('https://x.com/a?q=&quot;1&quot;');
  });
  it('stringifies non-strings and nullish', () => {
    expect(esc(123)).toBe('123');
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });
});

describe('describeProfile', () => {
  it('includes name, id and status', () => {
    const text = describeProfile(profile({ name: 'Дім', id: 'zzz' }));
    expect(text).toContain('Дім');
    expect(text).toContain('zzz');
    expect(text).toContain('активний');
  });
  it('shows paused status', () => {
    expect(describeProfile(profile({ paused: true }))).toContain('призупинено');
  });
  it('formats a full price/area range and marks all sites', () => {
    const text = describeProfile(
      profile({ criteria: { city: 'Київ', priceMin: 5000, priceMax: 15000, areaMin: 30, areaMax: 60, ownerOnly: false } }),
    );
    expect(text).toContain('5000–15000');
    expect(text).toContain('30–60');
    expect(text).toContain('усі сайти');
    expect(text).toContain('оренда');
  });

  it('shows rooms and sale operation, and owner only when constrained', () => {
    const rentText = describeProfile(profile({ criteria: { city: 'Київ', rooms: 4, ownerOnly: false } }));
    expect(rentText).toContain('4+-кімн.');
    const saleOwner = describeProfile(
      profile({ criteria: { city: 'Київ', operation: 'sale', ownerOnly: true } }),
    );
    expect(saleOwner).toContain('продаж');
    expect(saleOwner).toContain('лише власники');
  });
  it('formats "від"/"до"/"будь-яка" bounds', () => {
    expect(describeProfile(profile({ criteria: { city: 'Київ', priceMin: 5000, ownerOnly: true } }))).toContain(
      'від 5000',
    );
    expect(describeProfile(profile({ criteria: { city: 'Київ', priceMax: 9000, ownerOnly: true } }))).toContain(
      'до 9000',
    );
    expect(describeProfile(profile())).toContain('будь-яка');
  });
  it('includes district when present', () => {
    expect(
      describeProfile(profile({ criteria: { city: 'Київ', district: 'Поділ', ownerOnly: true } })),
    ).toContain('Поділ');
  });
});

describe('static copy', () => {
  it('exposes non-empty welcome/help/no-searches strings', () => {
    expect(WELCOME.length).toBeGreaterThan(0);
    expect(HELP).toBe(WELCOME);
    expect(NO_SEARCHES.length).toBeGreaterThan(0);
  });
});
