import * as cheerio from 'cheerio';
import { RawListing } from './listing.interface';

/**
 * Shared, defensive parsing helpers for the site specs. Everything here is
 * best-effort and returns empty/undefined rather than throwing — real markup
 * drifts, so specs lean on these and are expected to be tuned against the live
 * site over time.
 */

export function toInt(value: unknown): number | null {
  const n = Number.parseInt(String(value ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

export function toFloat(value: unknown): number | null {
  const n = Number.parseFloat(String(value ?? '').replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function absoluteUrl(href: string | undefined, baseUrl: string): string {
  if (!href) return baseUrl;
  if (href.startsWith('http')) return href;
  return `${baseUrl.replace(/\/+$/, '')}/${href.replace(/^\/+/, '')}`;
}

/**
 * rieltor.ua server-renders each listing as a `.catalog-card` with all fields
 * we need in attributes/markup (verified against the live page):
 *   - id     → `data-catalog-item-id`
 *   - price  → `data-label` ("20 000 грн", always UAH for the UA market)
 *   - specs  → `.catalog-card-details` ("2 кімнати · 80 / 60 / 10 м² · поверх…")
 *   - region → `.catalog-card-region` links ("Київ", "Дарницький р-н")
 *   - author → `.catalog-card-author-subtitle` ("Рієлтор" | "Власник")
 */
export function parseRieltor(html: string, baseUrl = 'https://rieltor.ua'): RawListing[] {
  try {
    const $ = cheerio.load(html);
    const out: RawListing[] = [];
    $('.catalog-card').each((_, el) => {
      const card = $(el);
      const id = card.attr('data-catalog-item-id');
      if (!id) return;

      const details = card.find('.catalog-card-details').text().replace(/\s+/g, ' ').trim();
      const rooms = toInt((details.match(/(\d+)[\s-]*кімнат/i) ?? [])[1]);
      // "80 / 60 / 10 м²" → 80 (total); "45 м²" → 45. First number before м².
      const area = toFloat((details.match(/([\d.,]+)(?:\s*\/\s*[\d.,]+)*\s*м²/) ?? [])[1]);

      const regions = card
        .find('.catalog-card-region a')
        .map((_, a) => $(a).text().trim())
        .get()
        .filter(Boolean);
      const district = regions.find((t) => /р-н|район/i.test(t));
      const address = card.find('.catalog-card-address').first().text().trim();

      const href =
        card.find('a.catalog-card-media').first().attr('href') ||
        card.find('a[href*="/view/"]').first().attr('href') ||
        `${baseUrl}/flats-rent/view/${id}/`;

      const img = card.find('img.offer-photo-slider-slide-image').first();
      const imageUrl =
        img.attr('src') ||
        img.attr('data-src') ||
        card.find('img.offer-photo-slider-blurred-bg').first().attr('src') ||
        undefined;

      const subtitle = card.find('.catalog-card-author-subtitle').first().text().toLowerCase();

      // Price in UAH. Rent is quoted in грн (data-label "20 000 грн"); sale is
      // quoted in $/€ ("185 000 $"), and rieltor puts the hryvnia equivalent in
      // the price-title's title attr ("По курсу НБУ - 8 306 389грн / …/м²").
      // Use that so we never mislabel a foreign price as грн (cf. C-1).
      const priceTitle = card.find('.catalog-card-price-title').first();
      const label = (card.attr('data-label') || priceTitle.text() || '').trim();
      let price: number | null;
      if (/грн/i.test(label)) {
        price = toInt(label);
      } else {
        // First "<num> грн" in the title is the full UAH price (per-m² comes after "/").
        const nbu = (priceTitle.attr('title') || '').match(/([\d\s  ]+)грн/);
        price = nbu ? toInt(nbu[1]) : null; // no UAH figure → no price, never a wrong one
      }

      const title =
        [
          rooms ? `${rooms}-кімн.` : null,
          area ? `${Math.round(area)} м²` : null,
          address || district || null,
        ]
          .filter(Boolean)
          .join(', ') || `Квартира ${id}`;

      out.push({
        id,
        title,
        price,
        currency: 'грн',
        area: area === null ? null : Math.round(area),
        rooms,
        city: regions[0] || undefined,
        district: district || undefined,
        url: absoluteUrl(href, baseUrl),
        imageUrl,
        // rieltor is realtor-first; only "Власник" is a private owner.
        isBusiness: !subtitle.includes('власник'),
      });
    });
    return out;
  } catch {
    return [];
  }
}
