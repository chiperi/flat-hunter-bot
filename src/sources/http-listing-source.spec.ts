jest.mock('axios');
import axios from 'axios';
import { HttpListingSource, SiteSpec } from './http-listing-source';
import { SearchCriteria } from './listing.interface';

const httpGet = jest.fn();
beforeEach(() => {
  httpGet.mockReset();
  (axios.create as jest.Mock).mockReturnValue({ get: httpGet });
});

const cfg = (over: Record<string, unknown> = {}): any => ({
  enabled: [],
  timeoutMs: 1000,
  maxRetries: 0,
  proxyUrl: undefined,
  domria: { baseUrl: 'https://d', maxDetails: 10 },
  ...over,
});

const criteria: SearchCriteria = { city: 'Київ', ownerOnly: false };

describe('HttpListingSource', () => {
  it('runs a declarative html spec and stamps the source', async () => {
    const spec: SiteSpec = {
      id: 't',
      label: 'T',
      kind: 'html',
      buildUrl: () => 'https://x/search',
      parse: () => [
        { id: '1', title: 'A', price: 100, currency: 'грн', area: null, url: 'u', isBusiness: false },
      ],
    };
    httpGet.mockResolvedValue({ status: 200, data: '<html></html>' });
    const source = new HttpListingSource(spec, cfg());
    const res = await source.fetchListings(criteria);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ id: '1', source: 't', sourceLabel: 'T' });
  });

  it('runs an imperative json fetch spec', async () => {
    const spec: SiteSpec = {
      id: 'd',
      label: 'D',
      fetch: async (ctx) => {
        const data: any = await ctx.getJson('https://api');
        return data.items.map((id: number) => ({
          id: String(id),
          title: 'x',
          price: null,
          currency: 'грн',
          area: null,
          url: 'u',
          isBusiness: false,
        }));
      },
    };
    httpGet.mockResolvedValue({ status: 200, data: { items: [1, 2] } });
    const source = new HttpListingSource(spec, cfg());
    const res = await source.fetchListings(criteria);
    expect(res.map((l) => l.id)).toEqual(['1', '2']);
  });

  it('returns [] on an HTTP error (never throws)', async () => {
    const spec: SiteSpec = { id: 't', label: 'T', kind: 'html', buildUrl: () => 'https://x', parse: () => [] };
    httpGet.mockResolvedValue({ status: 500, data: '' });
    const source = new HttpListingSource(spec, cfg());
    await expect(source.fetchListings(criteria)).resolves.toEqual([]);
  });

  it('returns [] when buildUrl yields null', async () => {
    const spec: SiteSpec = { id: 't', label: 'T', kind: 'html', buildUrl: () => null, parse: () => [] };
    const source = new HttpListingSource(spec, cfg());
    await expect(source.fetchListings(criteria)).resolves.toEqual([]);
  });

  it('passes a parsed proxy to axios', () => {
    new HttpListingSource({ id: 'p', label: 'P' }, cfg({ proxyUrl: 'http://user:pass@host:3128' }));
    const opts = (axios.create as jest.Mock).mock.calls.pop()![0];
    expect(opts.proxy).toMatchObject({ host: 'host', port: 3128 });
  });

  it('disables the proxy on an invalid url', () => {
    new HttpListingSource({ id: 'p', label: 'P' }, cfg({ proxyUrl: 'not a url' }));
    const opts = (axios.create as jest.Mock).mock.calls.pop()![0];
    expect(opts.proxy).toBe(false);
  });

  describe('requestKey', () => {
    const c: SearchCriteria = { city: 'Київ', ownerOnly: false };
    it('uses spec.requestKey when present', () => {
      const s = new HttpListingSource({ id: 'd', label: 'D', requestKey: (cr) => `k:${cr.city}` }, cfg());
      expect(s.requestKey(c)).toBe('k:Київ');
    });
    it('falls back to the built url', () => {
      const s = new HttpListingSource(
        { id: 't', label: 'T', kind: 'html', buildUrl: () => 'https://x/q', parse: () => [] },
        cfg(),
      );
      expect(s.requestKey(c)).toBe('https://x/q');
    });
    it('falls back to the full criteria', () => {
      const s = new HttpListingSource({ id: 'z', label: 'Z' }, cfg());
      expect(s.requestKey(c)).toContain('Київ');
    });
  });
});
