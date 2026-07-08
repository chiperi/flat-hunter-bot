import { SITE_SPECS, domriaCaches } from './site-specs';
import { SearchCriteria } from './listing.interface';

const cfg: any = {
  olx: { baseUrl: 'https://www.olx.ua', categoryPath: 'uk/nedvizhimost/kvartiry' },
  domria: { baseUrl: 'https://developers.ria.com', maxDetails: 2, apiKey: undefined },
};

const criteria: SearchCriteria = {
  city: 'Київ',
  district: 'Центр',
  priceMin: 5000,
  priceMax: 15000,
  areaMin: 30,
  areaMax: 60,
  ownerOnly: true,
};

describe('OLX spec', () => {
  it('builds a filtered search url', () => {
    const url = SITE_SPECS.olx.buildUrl!(criteria, cfg);
    expect(url).toContain('https://www.olx.ua/uk/nedvizhimost/kvartiry/');
    expect(url).toContain('5000');
    expect(url).toContain('15000');
    expect(url).toContain('private');
  });

  it('parses an offer from __NEXT_DATA__', () => {
    const offer = {
      id: 42,
      title: 'Квартира',
      url: '/d/uk/obyavlenie/kv-42.html',
      price: { value: 9000, currency: 'грн' },
      total_area: '50',
      location: { city: { name: 'Київ' }, district: { name: 'Центр' } },
      photos: [],
      business: false,
    };
    const html = `<script id="__NEXT_DATA__">${JSON.stringify({ props: { data: [offer] } })}</script>`;
    const res = SITE_SPECS.olx.parse!(html, cfg);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ id: '42', title: 'Квартира', price: 9000, area: 50 });
  });

  it('returns [] for empty html', () => {
    expect(SITE_SPECS.olx.parse!('<html></html>', cfg)).toEqual([]);
  });
});

describe('HTML specs build urls and parse __NEXT_DATA__', () => {
  it.each([
    ['rieltor', 'rieltor.ua'],
    ['lun', 'lun.ua'],
    ['flatfy', 'flatfy.ua'],
    ['birdrent', 'birdrent.com'],
    ['josti', 'josti.com.ua'],
  ])('%s → %s', (key, domain) => {
    const spec = SITE_SPECS[key];
    const url = spec.buildUrl!(criteria, cfg);
    expect(url).toContain(domain);

    const offer = { id: 7, title: 'T', url: '/x/7', price: { value: 1000 }, photos: [] };
    const html = `<script id="__NEXT_DATA__">${JSON.stringify({ items: [offer] })}</script>`;
    const res = spec.parse!(html, cfg);
    expect(res[0]).toMatchObject({ id: '7', title: 'T' });
  });
});

describe('DOM.RIA spec', () => {
  beforeEach(() => domriaCaches.clear()); // reset the module-level opt-2 cache

  it('returns [] without an api key', async () => {
    const ctx = { cfg, getHtml: jest.fn(), getJson: jest.fn() };
    await expect(SITE_SPECS.domria.fetch!(ctx as any, criteria)).resolves.toEqual([]);
  });

  it('skips an unmapped city without any API call', async () => {
    const dcfg = { ...cfg, domria: { ...cfg.domria, apiKey: 'k' } };
    const getJson = jest.fn();
    const ctx = { cfg: dcfg, getHtml: jest.fn(), getJson };
    await expect(
      SITE_SPECS.domria.fetch!(ctx as any, { city: 'Гадяч', ownerOnly: false }),
    ).resolves.toEqual([]);
    expect(getJson).not.toHaveBeenCalled();
  });

  it('resolves Kyiv geo, fetches details (capped), and maps fields', async () => {
    const dcfg = { ...cfg, domria: { ...cfg.domria, apiKey: 'k' } };
    const getJson = jest
      .fn()
      .mockResolvedValueOnce({ items: [1, 2, 3] }) // newest-first; capped to maxDetails=2
      .mockResolvedValueOnce({
        rooms_count: 2,
        total_square_meters: '50',
        price: 9000,
        city_name: 'Київ',
        street_name: 'Хрещатик',
        beautiful_url: 'realty-1',
        main_photo: 'a/b/p1.jpg',
        is_owner: 1,
      })
      .mockRejectedValueOnce(new Error('bad id')); // second detail fails → skipped
    const ctx = { cfg: dcfg, getHtml: jest.fn(), getJson };
    const res = await SITE_SPECS.domria.fetch!(ctx as any, criteria);

    // search url must carry the resolved Kyiv geo
    expect(getJson.mock.calls[0][0]).toContain('state_id=10');
    expect(getJson.mock.calls[0][0]).toContain('city_id=10');
    expect(getJson).toHaveBeenCalledTimes(3); // 1 search + 2 details (one throws)
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      id: '1',
      title: '2-кімн., 50 м², Хрещатик',
      price: 9000,
      area: 50,
      city: 'Київ',
      district: undefined,
      isBusiness: false,
      url: 'https://dom.ria.com/uk/realty-1',
      imageUrl: 'https://cdn.riastatic.com/photos/a/b/p1b.jpg',
    });
  });

  it('fetches details only for NEW ids on a second cycle (opt-2 cache)', async () => {
    const dcfg = { ...cfg, domria: { ...cfg.domria, apiKey: 'k' } };
    const info = (id: number) => ({
      rooms_count: 2,
      total_square_meters: '50',
      price: 9000,
      city_name: 'Київ',
      beautiful_url: `realty-${id}`,
      main_photo: `p${id}.jpg`,
      is_owner: 1,
    });
    // Cycle 1: ids [1,2] fetched (maxDetails=2). Cycle 2: newest is [3,2,1] → only 3 is new.
    const getJson = jest
      .fn()
      .mockResolvedValueOnce({ items: [2, 1] }) // search #1
      .mockResolvedValueOnce(info(2))
      .mockResolvedValueOnce(info(1))
      .mockResolvedValueOnce({ items: [3, 2, 1] }) // search #2 — a newcomer appears
      .mockResolvedValueOnce(info(3));
    const ctx = { cfg: dcfg, getHtml: jest.fn(), getJson };

    const first = await SITE_SPECS.domria.fetch!(ctx as any, criteria);
    expect(first.map((l) => l.id)).toEqual(['1', '2']); // newest-first (unshift order)

    const second = await SITE_SPECS.domria.fetch!(ctx as any, criteria);
    // only id 3 was fetched the second time (1 search + 1 detail)
    expect(getJson).toHaveBeenCalledTimes(5);
    expect(second.map((l) => l.id)).toEqual(['3', '1', '2']); // 3 prepended, rest cached
  });
});
