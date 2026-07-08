import { listingKey, KNOWN_SOURCE_IDS } from './listing.interface';

describe('listingKey', () => {
  it('namespaces the id by source', () => {
    expect(listingKey({ source: 'olx', id: '12345' })).toBe('olx:12345');
    expect(listingKey({ source: 'domria', id: '12345' })).toBe('domria:12345');
  });
  it('keeps same-id-different-source keys distinct', () => {
    expect(listingKey({ source: 'olx', id: '1' })).not.toBe(
      listingKey({ source: 'rieltor', id: '1' }),
    );
  });
});

describe('KNOWN_SOURCE_IDS', () => {
  it('contains the expected sources', () => {
    expect(KNOWN_SOURCE_IDS).toEqual(expect.arrayContaining(['olx', 'rieltor', 'domria']));
  });
});
