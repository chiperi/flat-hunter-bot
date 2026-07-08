/**
 * NBU exchange rates → hryvnia. Some sources (e.g. lun.ua) publish a price in
 * the seller's currency ($/€) with no pre-converted UAH value, so we convert
 * using the National Bank of Ukraine's official daily rate. Cached in-memory
 * (~6h) and degrades gracefully — a stale rate, or identity (UAH only), if the
 * NBU API is unreachable. Never throws.
 */
const NBU_URL = 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json';
const RATE_TTL_MS = 6 * 60 * 60 * 1000;

interface RateCache {
  at: number;
  rates: Record<string, number>; // UAH per 1 unit of the currency; UAH = 1
}
let cache: RateCache | null = null;

/** Test hook — drop the cached rates so a fresh fetch runs. */
export function resetRatesCache(): void {
  cache = null;
}

/** Current UAH-per-unit rates keyed by ISO code (USD, EUR, …). Cached ~6h. */
export async function uahRates(getJson: (url: string) => Promise<any>): Promise<Record<string, number>> {
  const now = Date.now();
  if (cache && now - cache.at < RATE_TTL_MS) return cache.rates;
  try {
    const arr = await getJson(NBU_URL);
    const rates: Record<string, number> = { UAH: 1 };
    for (const r of Array.isArray(arr) ? arr : []) {
      const cc = String(r?.cc ?? '').toUpperCase();
      if (cc && Number.isFinite(r?.rate) && r.rate > 0) rates[cc] = r.rate;
    }
    cache = { at: now, rates };
    return rates;
  } catch {
    return cache?.rates ?? { UAH: 1 }; // stale if we have it, else identity
  }
}

/** Convert `amount` in `currency` to whole hryvnia; null if unknown/absent. */
export function toUah(
  amount: number | null,
  currency: string,
  rates: Record<string, number>,
): number | null {
  if (amount == null) return null;
  const cc = String(currency || 'UAH').toUpperCase();
  if (cc === 'UAH' || cc === 'ГРН') return Math.round(amount);
  const rate = rates[cc];
  return rate ? Math.round(amount * rate) : null; // unknown currency → no price, never a wrong one
}
