import configuration from './configuration';

const VALID_TOKEN = '12345678:AAdummyTokenValidShape1234567890xyz';

describe('configuration', () => {
  const ORIGINAL = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL };
  });
  afterAll(() => {
    process.env = ORIGINAL;
  });

  it('throws when the token is missing', () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(() => configuration()).toThrow(/required/);
  });

  it('throws on a malformed token', () => {
    process.env.TELEGRAM_BOT_TOKEN = '111:short';
    expect(() => configuration()).toThrow(/malformed/);
  });

  it('builds config with sensible defaults', () => {
    process.env.TELEGRAM_BOT_TOKEN = VALID_TOKEN;
    delete process.env.SOURCES;
    delete process.env.ALLOWED_USER_IDS;
    const cfg = configuration();
    expect(cfg.sources.enabled).toEqual(['olx', 'rieltor', 'domria', 'lun', 'flatfy']);
    expect(cfg.redis.keyPrefix).toBe('olx');
    expect(cfg.polling.intervalMs).toBe(300000);
    expect(cfg.telegram.allowedUserIds).toEqual([]);
    expect(cfg.sources.domria.maxDetails).toBe(10);
  });

  it('parses allowlist and sources (dropping unknown ids)', () => {
    process.env.TELEGRAM_BOT_TOKEN = VALID_TOKEN;
    process.env.ALLOWED_USER_IDS = '1, 2 ,x,3';
    process.env.SOURCES = 'olx, unknown ,domria';
    const cfg = configuration();
    expect(cfg.telegram.allowedUserIds).toEqual([1, 2, 3]);
    expect(cfg.sources.enabled).toEqual(['olx', 'domria']);
  });

  it('reads DOM.RIA + proxy settings', () => {
    process.env.TELEGRAM_BOT_TOKEN = VALID_TOKEN;
    process.env.DOMRIA_API_KEY = 'k';
    process.env.DOMRIA_MAX_DETAILS = '5';
    process.env.HTTP_PROXY_URL = 'http://proxy:8080';
    const cfg = configuration();
    expect(cfg.sources.domria.apiKey).toBe('k');
    expect(cfg.sources.domria.maxDetails).toBe(5);
    expect(cfg.sources.proxyUrl).toBe('http://proxy:8080');
  });
});
