import { toInt, toFloat, absoluteUrl, parseRieltor } from './parsing.util';

describe('toInt', () => {
  it.each([
    ['5 000 грн', 5000],
    ['10000', 10000],
    ['12,5', 125],
  ])('parses %s → %d', (input, expected) => {
    expect(toInt(input)).toBe(expected);
  });
  it.each(['', 'abc', null, undefined])('returns null for %s', (input) => {
    expect(toInt(input)).toBeNull();
  });
});

describe('toFloat', () => {
  it('parses comma decimals', () => {
    expect(toFloat('45,5 м²')).toBeCloseTo(45.5);
  });
  it.each(['0', 'abc', '', null])('returns null for non-positive/invalid %s', (input) => {
    expect(toFloat(input)).toBeNull();
  });
});

describe('absoluteUrl', () => {
  it('keeps absolute urls', () => {
    expect(absoluteUrl('https://y.com/a', 'https://x.com')).toBe('https://y.com/a');
  });
  it('joins relative urls', () => {
    expect(absoluteUrl('/a/b', 'https://x.com/')).toBe('https://x.com/a/b');
  });
  it('falls back to base when href missing', () => {
    expect(absoluteUrl(undefined, 'https://x.com')).toBe('https://x.com');
  });
});

describe('parseRieltor', () => {
  // Compact fixtures mirroring rieltor.ua's real .catalog-card markup.
  const realtorCard = `
    <div class="catalog-card " data-catalog-item-id="111" data-label="20 000 грн">
      <a href="https://rieltor.ua/flats-rent/view/111/" class="catalog-card-media">
        <img class="offer-photo-slider-slide-image" src="https://img.cdn/111.jpg">
      </a>
      <div class="catalog-card-content">
        <div class="catalog-card-price"><strong class="catalog-card-price-title">20 000 грн/міс</strong></div>
        <h2>
          <div class="catalog-card-address">Хрещатик, 1</div>
          <div class="catalog-card-region"><a>Київ</a>, <a>Печерський р-н</a></div>
        </h2>
        <div class="catalog-card-details"><div class="catalog-card-details-row">
          <span>2 кімнати</span><span>80 / 60 / 10 м²</span><span>поверх 5 з 9</span>
        </div></div>
        <div class="catalog-card-author"><div class="catalog-card-author-subtitle">Рієлтор</div></div>
      </div>
    </div>`;
  const ownerCard = `
    <div class="catalog-card " data-catalog-item-id="222" data-label="12 500 грн">
      <a href="https://rieltor.ua/flats-rent/view/222/" class="catalog-card-media"></a>
      <div class="catalog-card-region"><a>Київ</a></div>
      <div class="catalog-card-details"><span>1-кімнатна</span><span>45 м²</span></div>
      <div class="catalog-card-author"><div class="catalog-card-author-subtitle">Власник</div></div>
    </div>`;

  it('parses a realtor card: price/area/rooms/district/business', () => {
    const [l] = parseRieltor(`<html>${realtorCard}</html>`);
    expect(l).toMatchObject({
      id: '111',
      price: 20000,
      currency: 'грн',
      area: 80, // total, not living/kitchen
      rooms: 2,
      city: 'Київ',
      district: 'Печерський р-н',
      isBusiness: true, // "Рієлтор"
      url: 'https://rieltor.ua/flats-rent/view/111/',
      imageUrl: 'https://img.cdn/111.jpg',
    });
    expect(l.title).toContain('2-кімн.');
  });

  it('flags "Власник" as a private owner and handles a single area value', () => {
    const [l] = parseRieltor(`<html>${ownerCard}</html>`);
    expect(l).toMatchObject({ id: '222', price: 12500, area: 45, rooms: 1, isBusiness: false });
    expect(l.district).toBeUndefined();
  });

  it('parses multiple cards and skips ones without an id', () => {
    const noId = '<div class="catalog-card ">no id</div>';
    const res = parseRieltor(`<html>${realtorCard}${ownerCard}${noId}</html>`);
    expect(res.map((l) => l.id)).toEqual(['111', '222']);
  });

  it('returns [] for empty/garbage html', () => {
    expect(parseRieltor('<html></html>')).toEqual([]);
  });
});
