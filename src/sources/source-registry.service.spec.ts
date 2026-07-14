import { SourceRegistry } from './source-registry.service';
import { Listing, SearchCriteria } from './listing.interface';
import { ListingSource } from './listing-source.interface';

const criteria: SearchCriteria = { city: 'Київ', ownerOnly: false };

const listing = (id: string, source: string): Listing => ({
  id,
  title: 'Flat',
  price: 1,
  currency: 'грн',
  area: null,
  url: 'u',
  isBusiness: false,
  source,
  sourceLabel: source,
});

const src = (id: string, impl: () => Promise<Listing[]>): ListingSource => ({
  id,
  label: id,
  fetchListings: jest.fn(impl),
});

describe('SourceRegistry', () => {
  it('reports the active source count', () => {
    const reg = new SourceRegistry([src('a', async () => []), src('b', async () => [])]);
    expect(reg.count).toBe(2);
  });

  it('fetchOne returns a source\'s listings', async () => {
    const reg = new SourceRegistry([src('a', async () => [listing('1', 'a'), listing('2', 'a')])]);
    const res = await reg.fetchOne('a', criteria);
    expect(res).toHaveLength(2);
    expect(res.map((l) => l.source)).toEqual(['a', 'a']);
  });

  it('fetchOne isolates a throwing source (returns [])', async () => {
    const reg = new SourceRegistry([
      src('b', async () => {
        throw new Error('boom');
      }),
    ]);
    await expect(reg.fetchOne('b', criteria)).resolves.toEqual([]);
  });

  it('fetchOne returns [] for an unknown source / empty registry', async () => {
    const reg = new SourceRegistry([]);
    expect(reg.count).toBe(0);
    await expect(reg.fetchOne('x', criteria)).resolves.toEqual([]);
  });

  it('exposes ids and has()', () => {
    const reg = new SourceRegistry([src('a', async () => []), src('b', async () => [])]);
    expect(reg.ids).toEqual(['a', 'b']);
    expect(reg.has('a')).toBe(true);
    expect(reg.has('z')).toBe(false);
  });

  it('fetchOne targets a single source', async () => {
    const reg = new SourceRegistry([
      src('a', async () => [listing('1', 'a')]),
      src('b', async () => [listing('2', 'b')]),
    ]);
    expect((await reg.fetchOne('a', criteria)).map((l) => l.id)).toEqual(['1']);
  });

  it('fetchOne returns [] for an unknown or throwing source', async () => {
    const reg = new SourceRegistry([
      src('b', async () => {
        throw new Error('boom');
      }),
    ]);
    await expect(reg.fetchOne('missing', criteria)).resolves.toEqual([]);
    await expect(reg.fetchOne('b', criteria)).resolves.toEqual([]);
  });
});
