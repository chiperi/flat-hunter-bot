import { toUah, uahRates, resetRatesCache } from './currency';

describe('toUah', () => {
  const rates = { UAH: 1, USD: 41, EUR: 45 };
  it('keeps hryvnia as-is (uah / грн, any case)', () => {
    expect(toUah(18000, 'uah', rates)).toBe(18000);
    expect(toUah(18000, 'ГРН', rates)).toBe(18000);
    expect(toUah(18000, 'UAH', rates)).toBe(18000);
  });
  it('converts a foreign currency at the NBU rate', () => {
    expect(toUah(2500, 'usd', rates)).toBe(102500); // 2500 × 41
    expect(toUah(1000, 'EUR', rates)).toBe(45000);
  });
  it('returns null for an unknown currency or missing amount', () => {
    expect(toUah(100, 'GBP', rates)).toBeNull(); // never a wrong number
    expect(toUah(null, 'usd', rates)).toBeNull();
  });
});

describe('uahRates', () => {
  beforeEach(() => resetRatesCache());

  it('builds a UAH-per-unit map from the NBU payload (and includes UAH=1)', async () => {
    const getJson = jest.fn().mockResolvedValue([
      { cc: 'USD', rate: 41.2 },
      { cc: 'EUR', rate: 45.6 },
      { cc: 'BAD', rate: 0 }, // dropped (non-positive)
    ]);
    const rates = await uahRates(getJson);
    expect(rates).toMatchObject({ UAH: 1, USD: 41.2, EUR: 45.6 });
    expect(rates.BAD).toBeUndefined();
  });

  it('caches — a second call within TTL does not hit the API again', async () => {
    const getJson = jest.fn().mockResolvedValue([{ cc: 'USD', rate: 40 }]);
    await uahRates(getJson);
    await uahRates(getJson);
    expect(getJson).toHaveBeenCalledTimes(1);
  });

  it('degrades to identity when the API fails and nothing is cached', async () => {
    const getJson = jest.fn().mockRejectedValue(new Error('down'));
    expect(await uahRates(getJson)).toEqual({ UAH: 1 });
  });
});
