import { matchesCriteria, defaultProfileName } from './search-profile.model';
import { Listing, SearchCriteria } from '../sources/listing.interface';

const criteria = (over: Partial<SearchCriteria> = {}): SearchCriteria => ({
  city: 'Київ',
  ownerOnly: false,
  ...over,
});

const listing = (over: Partial<Listing> = {}): Listing => ({
  id: '1',
  title: 'Flat',
  price: 10000,
  currency: 'грн',
  area: 45,
  city: 'Київ',
  district: 'Центр',
  url: 'https://rieltor.ua/1',
  isBusiness: false,
  source: 'rieltor',
  sourceLabel: 'Rieltor',
  ...over,
});

describe('matchesCriteria', () => {
  it('rejects business listings when ownerOnly', () => {
    expect(matchesCriteria(listing({ isBusiness: true }), criteria({ ownerOnly: true }))).toBe(
      false,
    );
    expect(matchesCriteria(listing({ isBusiness: true }), criteria({ ownerOnly: false }))).toBe(
      true,
    );
  });
  it('enforces price bounds', () => {
    const c = criteria({ priceMin: 5000, priceMax: 15000 });
    expect(matchesCriteria(listing({ price: 4000 }), c)).toBe(false);
    expect(matchesCriteria(listing({ price: 16000 }), c)).toBe(false);
    expect(matchesCriteria(listing({ price: 10000 }), c)).toBe(true);
  });
  it('enforces area bounds', () => {
    const c = criteria({ areaMin: 30, areaMax: 60 });
    expect(matchesCriteria(listing({ area: 20 }), c)).toBe(false);
    expect(matchesCriteria(listing({ area: 70 }), c)).toBe(false);
    expect(matchesCriteria(listing({ area: 45 }), c)).toBe(true);
  });
  it('matches district as a case-insensitive substring', () => {
    const c = criteria({ district: 'центр' });
    expect(matchesCriteria(listing({ district: 'Центральний' }), c)).toBe(true);
    expect(matchesCriteria(listing({ district: 'Поділ' }), c)).toBe(false);
  });
  it('excludes a listing with no price ("Ціна договірна"), even with no price filter', () => {
    expect(matchesCriteria(listing({ price: null }), criteria())).toBe(false);
    expect(matchesCriteria(listing({ price: null }), criteria({ priceMax: 15000 }))).toBe(false);
  });
  it('skips the area check when the listing has no area', () => {
    const c = criteria({ areaMin: 30 });
    expect(matchesCriteria(listing({ area: null }), c)).toBe(true);
  });
});

describe('defaultProfileName', () => {
  it('uses city + district when present', () => {
    expect(defaultProfileName(criteria({ district: 'Центр' }))).toBe('Київ, Центр');
  });
  it('uses just the city otherwise', () => {
    expect(defaultProfileName(criteria())).toBe('Київ');
  });
});
