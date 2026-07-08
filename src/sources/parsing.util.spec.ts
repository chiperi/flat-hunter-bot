import {
  toInt,
  toFloat,
  absoluteUrl,
  extractNextData,
  deepFindOffers,
  mapOffer,
  parseCards,
  parseRieltor,
  idFromHref,
} from './parsing.util';

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

describe('extractNextData', () => {
  it('parses embedded __NEXT_DATA__ JSON', () => {
    const html = '<script id="__NEXT_DATA__" type="application/json">{"a":1}</script>';
    expect(extractNextData(html)).toEqual({ a: 1 });
  });
  it('returns null without the script', () => {
    expect(extractNextData('<div>no data</div>')).toBeNull();
  });
  it('returns null on invalid JSON', () => {
    expect(extractNextData('<script id="__NEXT_DATA__">{oops</script>')).toBeNull();
  });
});

describe('deepFindOffers', () => {
  it('collects offer-shaped objects anywhere in the tree', () => {
    const tree = {
      props: {
        list: [{ id: 1, title: 'T', url: '/u' }, { foo: 'bar' }],
        nested: { deep: { id: 2, title: 'X', url: '/x' } },
      },
    };
    const offers = deepFindOffers(tree);
    expect(offers.map((o) => o.id).sort()).toEqual([1, 2]);
  });
  it('is bounded and safe on primitives', () => {
    expect(deepFindOffers(null)).toEqual([]);
    expect(deepFindOffers(42)).toEqual([]);
  });
});

describe('mapOffer', () => {
  const base = 'https://olx.ua';
  it('maps a rich offer', () => {
    const listing = mapOffer(
      {
        id: 5,
        title: ' Flat ',
        url: '/d/5',
        price: { value: 10000, currency: 'грн' },
        total_area: '45',
        location: { city: { name: 'Київ' }, district: { name: 'Центр' } },
        photos: [{ link: 'http://img/1.jpg' }],
        business: true,
      },
      base,
    );
    expect(listing).toMatchObject({
      id: '5',
      title: 'Flat',
      price: 10000,
      area: 45,
      city: 'Київ',
      district: 'Центр',
      url: 'https://olx.ua/d/5',
      imageUrl: 'http://img/1.jpg',
      isBusiness: true,
    });
  });

  it('defaults price/area to null and isBusiness to false', () => {
    const listing = mapOffer({ id: 'x', title: 'T', url: '/x' }, base);
    expect(listing).toMatchObject({ price: null, area: null, isBusiness: false, currency: 'грн' });
  });

  it('returns null when mapping throws', () => {
    const evil = {
      id: {
        toString() {
          throw new Error('boom');
        },
      },
      title: 'T',
      url: '/x',
    };
    expect(mapOffer(evil, base)).toBeNull();
  });
});

describe('parseCards', () => {
  const sel = {
    card: '[data-cy="l-card"]',
    title: 'h6',
    price: '[data-testid="ad-price"]',
    link: 'a[href]',
    image: 'img',
  };
  it('parses server-rendered cards', () => {
    const html =
      '<div data-cy="l-card"><a href="/item/12345">l</a><h6>Title</h6>' +
      '<span data-testid="ad-price">10 000 грн</span><img src="http://img"/></div>';
    const cards = parseCards(html, sel, 'https://olx.ua');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: '12345',
      title: 'Title',
      price: 10000,
      url: 'https://olx.ua/item/12345',
      imageUrl: 'http://img',
      isBusiness: false,
    });
  });
  it('skips cards without a link or title', () => {
    const html = '<div data-cy="l-card"><h6>NoLink</h6></div>';
    expect(parseCards(html, sel, 'https://olx.ua')).toEqual([]);
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

describe('idFromHref', () => {
  it('extracts the numeric segment', () => {
    expect(idFromHref('/d/uk/obyavlenie/kvartira-12345.html')).toBe('12345');
  });
  it('falls back to the last segment', () => {
    expect(idFromHref('https://x.com/a/slug?q=1')).toBe('slug');
  });
});
