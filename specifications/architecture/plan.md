# Technical Plan — flat-hunter-bot

**Stack:** Node 20 · TypeScript · NestJS 10 · nestjs-telegraf (Telegraf 4, long polling) ·
Redis (ioredis) · cheerio · axios · Jest + ts-jest. Lint/format: Prettier + ESLint (nest defaults).

> Фактична архітектура вже реалізованого бота. Детальна поведінка — у
> [`../product/specs/002-existing/spec.md`](../product/specs/002-existing/spec.md);
> рішення — в [`decisions/`](decisions/); числа — в [`nfr.md`](nfr.md).

## Модулі (NestJS)

```
src/
├── config/           типізований парсинг env (одне місце дефолтів/валідації)
├── telegram/         команди, /newsearch майстер (Scene), allowlist middleware, формат сповіщень
├── sources/          ListingSource-інтерфейс, SiteSpec-и, HttpListingSource, SourceRegistry
├── search-profiles/  модель профілю + сервіс CRUD/lifecycle
├── persistence/      один Redis-клієнт + репозиторії (profiles, seen-listings)
└── scheduler/        джиттер-цикл опитування (dedup → diff → notify)
```

- **`telegram/`** — `TelegramUpdate` (команди `/start` `/help` `/newsearch` `/mysearches`
  `/pause` `/resume` `/forgetme` + inline Pause/Resume/Delete), `NewSearchWizard` (@Scene стан-машина:
  operation → city → rooms → price → area), `allowlist.middleware` (fail-closed), `TelegramService`
  (вихідні сповіщення + `bot.catch` + `setMyCommands`). Копірайт — у `telegram.copy.ts`.
- **`sources/`** — ядро за інтерфейсом. `SiteSpec` описує сайт **декларативно** (`buildUrl`+`parse`)
  або **імперативно** (`fetch`, для 2-крокового DOM.RIA API). `HttpListingSource` виконує SiteSpec
  (retry/proxy/UA/джиттер, `[]` на будь-якому збої). `SourceRegistry` веде реєстр активних джерел
  (`SOURCES`) і дедуп-ключі. Живі: **DOM.RIA** (офіційне API) + **Rieltor** (server-rendered HTML).
- **`scheduler/`** — самоперепланований цикл: збирає унікальні `(source, requestKey)` → фетчить їх
  **конкурентно** (`Promise.all`, дедуп) → для кожного профілю зливає списки всіх джерел → діфить
  проти seen-hash → notify. Overlap-guard пропускає такт, якщо попередній ще біжить.

## Модель даних (Redis-only)

| Ключ (`{p}` = `REDIS_KEY_PREFIX`, legacy `olx`) | Тип | Призначення |
|---|---|---|
| `{p}:profile:{id}` | JSON | `SearchProfile` |
| `{p}:user:{userId}:profiles` | Set | id профілів користувача |
| `{p}:profiles:all` | Set | усі id (планувальник ітерує це) |
| `{p}:seen:{profileId}` | **Hash** `source:id → lastPrice` | дедуп **і** детекція зміни ціни |

Seen — саме Hash: збережена ціна ≠ свіжій → сигнал «зміна ціни». Проставляється лише після успішної
відправки. Priming: перший опит показує кілька найновіших і **тихо** сідить решту (без флуду).

## Потік одного циклу

1. Завантажити активні (не paused) профілі.
2. Зібрати унікальні `(source, requestKey)` → `Promise.all(fetchOne)` (кеш на цикл).
3. Для кожного профілю: злити оголошення всіх джерел → `matchesCriteria` (ціна/площа/кімнати/район;
   без ціни → виключити) → діф проти seen-hash → notify new / price-change → mark-seen після send.
4. Перепланувати з джиттером.

## Джерела (деталі)

- **DOM.RIA** — 2 кроки: `/dom/search` (id-и, ціна пушиться в запит `price_from/price_to`) →
  `/dom/info/{id}` (деталі). Opt-2 кеш: деталі тягнуться лише для нових id (cap `DOMRIA_MAX_DETAILS`);
  warn-лог при переповненні бюджету. Ціна в грн через `priceArr["3"]`.
- **Rieltor** — server-rendered `.catalog-card`. URL-фільтри: `price_min/price_max`, `rooms`, `f-owners`.
  Ціна: rent у грн (`data-label`), sale у $/€ → грн з НБУ-еквівалента в `title` price-title.

## Тестова стратегія

- **Jest + ts-jest**, юніт-рівень; `ioredis-mock` для репозиторіїв (реальні round-trip'и).
- Найкраще покрито найризикованіше: планувальник (priming/diff/dedup/delivery-contract), DOM.RIA spec
  (geo/currency/opt-2), `matchesCriteria`, майстер (стан-машина, cancel, re-prompt), allowlist.
- **Coverage-gate** у CI: 80/80/80/70 (statements/branches/functions/lines), enforced на кожному push/PR.

## Деплой

GitHub Actions → DigitalOcean дроплет по SSH: `rsync` коду + `docker compose up -d --build` під
`/opt/flat-hunter-bot/`. Секрети — env через SSH stdin, не пишуться у файл; `restart: unless-stopped`.
Ізольований стек, без вхідних портів.

---

## Planned feature: OLX via residential proxy

> **Status: planned, not built.** Design for
> [`../product/specs/001-feature/spec.md`](../product/specs/001-feature/spec.md) (US-1..4,
> FR-001..014, SC-001..007). Decisions: [ADR-0005](decisions/0005-olx-proxy-gated-source.md)
> (proxy-gated OLX), [ADR-0006](decisions/0006-nbu-currency-converter.md) (NBU converter),
> [ADR-0007](decisions/0007-olx-next-data-parser.md) (`__NEXT_DATA__` parser). This section
> **appends** to the shipped-system plan above; nothing above changes. OLX joins the existing
> "one filter, all sources" model as a third source — no scheduler, dedup, `matchesCriteria`,
> wizard, or data-model change. Re-enables **OLX only** (ADR-0003: not lun/flatfy/birdrent/josti).

### Build approach (restore + gate + register)

Almost entirely a **restore** of code removed with OLX/lun (PRs #23, #19; recoverable from git
prior to commit `9c61511`), re-fitted to today's `SiteSpec`/`SiteContext` shape:

1. **Register the id.** Add `'olx'` to `KNOWN_SOURCE_IDS` and `olx: 'OLX'` to `SOURCE_LABELS`
   (`src/sources/listing.interface.ts:64,67-70`) so `SOURCES=olx` (or unset → default-all,
   `src/config/configuration.ts:74-79`) is recognised, not dropped as unknown (FR-003).
2. **Restore the OLX `SiteSpec`** in `SITE_SPECS` (`src/sources/site-specs.ts:200-203`), mirroring
   `rieltor`/`domria`. It uses the **imperative `fetch`** path (like DOM.RIA) so it can `await` the
   rate load before mapping (see ADR-0006). Shape: `{ id: 'olx', label: 'OLX', requiresProxy: true,
   requestKey, fetch }`. Fields produced per `RawListing` (FR-001): id/title/price/currency/area/
   rooms/city/district(when confident)/url/imageUrl/isBusiness.
3. **Restore the `__NEXT_DATA__` parser cluster** (ADR-0007): generic `extractNextData` +
   `deepFindOffers` → new `src/sources/next-data.util.ts`; OLX-specific `mapOffer` /
   `parseCards` / `nextDataThenCards` + the Kyiv rent/sale URL builder → alongside the spec in
   `src/sources/site-specs.ts`, reusing `toInt`/`toFloat`/`absoluteUrl`
   (`src/sources/parsing.util.ts:11-25`). Fail closed to `[]` on any shape mismatch (FR-002, FR-008).
4. **Restore the NBU converter** (ADR-0006): `src/sources/currency.ts` exporting `toUah(amount,
   currency, rates)` + cached `ensureRates(getJson)` populating module-level `uahRates` (~24h TTL,
   in-memory). OLX's `fetch` calls `await ensureRates(ctx.getJson)`, then `mapOffer` delegates price
   normalization to `toUah`; unresolved rate/price → `price: null` (FR-005).
5. **Gate on the proxy** (ADR-0005): add optional `requiresProxy?: boolean` to the `SiteSpec`
   interface (`src/sources/http-listing-source.ts:21-32`); the sources-module factory
   (`src/sources/sources.module.ts:14-25`) skips instantiating any `requiresProxy` spec when
   `!cfg.proxyUrl` and logs one startup notice naming the reason (FR-006, US-3, SC-004). OLX routes
   through the shared `cfg.proxyUrl` axios `proxy` — no new proxy path (FR-007,
   `src/sources/http-listing-source.ts:56-65,139-158`).
6. **Docs** (FR-013, SC-007): note in `README.md` / `.env.example` that `SOURCES` may include `olx`,
   that `olx` requires `HTTP_PROXY_URL`, and the ToS/GDPR caveats.

### Where each piece lands

| Piece | Path | Note |
|---|---|---|
| `olx` id + label | `src/sources/listing.interface.ts:64,67-70` | add to `KNOWN_SOURCE_IDS`, `SOURCE_LABELS` |
| OLX `SiteSpec` (imperative `fetch`, `requiresProxy`, `requestKey`) | `src/sources/site-specs.ts` (+ register at `:200-203`) | restore; mirrors `domria` |
| OLX URL builder + `mapOffer` + `parseCards`/`nextDataThenCards` | `src/sources/site-specs.ts` | OLX-specific; Kyiv rent/sale, price into query where supported |
| Generic `extractNextData` + `deepFindOffers` | `src/sources/next-data.util.ts` (new) | source-agnostic, pure, reusable |
| NBU converter `toUah` + `ensureRates` + `uahRates` | `src/sources/currency.ts` (restore) | ~24h cache, fail-closed |
| `requiresProxy?: boolean` on `SiteSpec` | `src/sources/http-listing-source.ts:21-32` | one optional field; back-compat |
| Proxy gate + startup notice | `src/sources/sources.module.ts:14-25` | single gate + single log site |
| Docs | `README.md`, `.env.example` | `olx` value + "requires `HTTP_PROXY_URL`" + caveats |

**Unchanged (by design):** `configuration.ts` stays a pure env→data mapper (only *learns* `olx`
exists; the behavioural gate is the factory); `scheduler.service.ts`, `source-registry.service.ts`,
`matchesCriteria`, the wizard, and the Redis data model are **not touched** — OLX is just another
entry in `SITE_SPECS`.

### Data flow (fits the existing cycle unchanged)

`SchedulerService.runCycle` (`src/scheduler/scheduler.service.ts:93-141`) already fans each unique
`(source, requestKey)` out concurrently and merges per profile — OLX slots in with zero changes:

1. **Gate (startup, once):** factory builds an `HttpListingSource` for `olx` **iff** `HTTP_PROXY_URL`
   is set; otherwise OLX is absent from `LISTING_SOURCES` and the scheduler never sees it (SC-004).
2. **Fetch (per cycle, when active):** scheduler calls `sources.fetchOne('olx', criteria)` →
   `HttpListingSource.fetchListings` → OLX `fetch(ctx, criteria)`: build Kyiv URL →
   `await ensureRates(ctx.getJson)` → `ctx.getHtml(url)` (proxied, retry/UA/jitter) →
   `nextDataThenCards` → `mapOffer` (→ `toUah`). Any failure → `[]` (FR-008, SC-005).
3. **Tag:** `HttpListingSource.fetchListings` stamps `source:'olx'` / `sourceLabel:'OLX'`
   (`src/sources/http-listing-source.ts:70`); dedup key is `"olx:<id>"` via `listingKey()`
   (`src/sources/listing.interface.ts:56-58`) → no collision with a same-numbered DOM.RIA/Rieltor id
   (FR-010, SC-003).
4. **Match / notify / seen:** merged with the other sources → `matchesCriteria` (null price →
   excluded, `src/search-profiles/search-profile.model.ts:36-38`) → diff vs seen-hash →
   notify-new / notify-price-change → mark-seen after send. Identical to DOM.RIA/Rieltor (US-1).

### Test strategy (coverage gate held: 80/80/80/70, SC-006 / NFR-009)

- **OLX parse fixture** — a saved `__NEXT_DATA__` HTML fixture with several offers, including **one
  USD-priced and one UAH-priced** offer: assert id/title/url/area/rooms mapped, UAH passed through,
  USD converted to грн, `source`/`sourceLabel`/`listingKey` = `olx` (US-1, US-2, FR-001, SC-003).
- **Proxy-gating** — factory/helper test: OLX **excluded** from built sources when `cfg.proxyUrl` is
  empty (and one notice logged), **included** when set; assert **zero** HTTP calls attempted with no
  proxy (US-3, FR-006, SC-004).
- **Currency conversion** — `toUah`: USD/EUR with a mock rate table → correct грн; missing rate →
  `null`; `ensureRates` with a `getJson` that throws → `uahRates` stays empty, `toUah` returns
  `null` for foreign, UAH unaffected (US-2, FR-005, SC-002).
- **Fail-closed** — malformed/empty `__NEXT_DATA__`, `getHtml` throw, failed rate lookup → each
  yields `[]`, **no** throw reaching `SourceRegistry`/scheduler, **no** impact on other sources
  (FR-008, SC-005). Extends the existing `site-specs.spec.ts`/`http-listing-source.spec.ts` patterns.
- **Docs by inspection** — `README.md`/`.env.example` list `olx` + the proxy requirement (SC-007).

### Feature-specific NFRs (see [`nfr.md`](nfr.md))

No new contracts: OLX exposes no API — it consumes the site's undocumented `__NEXT_DATA__` blob,
defensively parsed (so no OpenAPI/AsyncAPI applies). Feature-specific numbers, all mapping to
existing NFRs:

- **Currency-rate freshness** (extends NFR-005/NFR-006 frugality): ≤ ~1 NBU rate fetch/day (~24h TTL
  cache), **not** per cycle; a displayed OLX UAH figure is ≤ ~24h stale — else `null`, never guessed.
- **Proxy/parse failure → `[]`** (instantiates NFR-004 resilience): any OLX fetch/parse/rate failure
  contributes `[]` and **0** unhandled exceptions to the cycle; DOM.RIA/Rieltor/other profiles
  unaffected (SC-005).
- **Un-proxied requests = 0** (extends NFR-006): with no `HTTP_PROXY_URL`, OLX issues **0** direct
  requests across a full cycle — enforced structurally (not instantiated), not by a runtime guard
  (SC-004).
- **Privacy unchanged** (NFR-008): OLX stores only the existing non-PII fields — **0** phone
  numbers / seller names / contact handles, even when the payload exposes them (FR-014).
