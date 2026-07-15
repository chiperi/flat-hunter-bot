# Product Specification: Proxy-Enabled OLX Source

**Status:** Draft

## Problem & context

Flat Hunter Bot today monitors Kyiv rental/sale listings against **one filter per user, across
every enabled source** — currently **DOM.RIA** (official API) and **Rieltor** (server-rendered
HTML) (`src/sources/listing.interface.ts:64`, `KNOWN_SOURCE_IDS = ['domria', 'rieltor']`).
**OLX.ua** was evaluated during initial source selection and **removed entirely** (PR #23,
commit `9c61511`) because OLX.ua returns HTTP `403` to the droplet's datacenter IP — a
Cloudflare bot-fight challenge that a direct fetch cannot pass
([`specifications/architecture/decisions/0003-sources-landscape.md`](../../../architecture/decisions/0003-sources-landscape.md)).
OLX is a source of real coverage the bot's users would benefit from: it lists inventory that
neither DOM.RIA nor Rieltor carries.

The blocker has a known, narrow fix that the codebase is already partway built for:
`HttpListingSource` already reads an optional `HTTP_PROXY_URL` and wires it into its axios
client (`parseProxy`, `src/sources/http-listing-source.ts:59,139-158`) — this plumbing was
built generically, not for any one source, and today sits unused because no enabled source
needs a proxy. ADR-0003 names exactly this as the reopening condition: "Розширення
(OLX/lun/flatfy) впирається в **один** блокер — резидентський/ротаційний проксі
(`HTTP_PROXY_URL`); тоді джерела вмикаються без нового коду"
(`specifications/architecture/decisions/0003-sources-landscape.md:25-26`).

This feature re-enables **OLX only** (not lun.ua/flatfy.ua — ADR-0003 excludes them as
duplicates of the DOM.RIA/Rieltor ecosystem, not as proxy-blocked) by:
1. Restoring an OLX `SiteSpec` (parsing OLX's `__NEXT_DATA__` embedded JSON into listing cards —
   the shape that existed before PR #23 and is recoverable from git history prior to commit
   `9c61511`).
2. Re-adding `olx` to `KNOWN_SOURCE_IDS` / `SOURCE_LABELS` (`src/sources/listing.interface.ts:64,67-70`).
3. Restoring currency normalization to UAH for OLX listings, which may be priced in UAH, USD, or
   EUR (unlike Rieltor rent, which is always UAH, or DOM.RIA, which always exposes a UAH
   equivalent) — an NBU-rate converter existed in the pre-#23 OLX adapter and was removed with
   it; this feature restores that conversion step specifically for OLX.
4. Gating OLX so it only ever runs behind a configured proxy — never falling back to a direct,
   soon-to-be-403'd fetch.

This is a **problem-and-behavior specification**: it defines what must be true for OLX listings
to safely rejoin the bot's result set. It does not prescribe the exact OLX card markup, the
`__NEXT_DATA__` traversal path, or which proxy vendor to use — those are implementation/plan
concerns.

**Assumption (resolved, not open):** "a residential/rotating proxy" means any HTTP(S) proxy
endpoint reachable via `HTTP_PROXY_URL` (already the shape `HttpListingSource.parseProxy`
expects: `protocol://[user:pass@]host:port`, `src/sources/http-listing-source.ts:139-158`) that
successfully passes OLX's Cloudflare challenge from the droplet. Procuring/operating that proxy
is an infrastructure/ops task outside this spec's scope; this spec assumes one is configured and
specifies the bot's behavior once it is.

---

## User stories

### US-1 (P1 — MVP): OLX listings appear in results once a proxy is configured

As an allowlisted user with a saved search, I want OLX listings that match my filter to show up
in my notifications (same as DOM.RIA/Rieltor today), so my one filter covers more of the market
without me doing anything differently.

Acceptance criteria (Given/When/Then):
- **GIVEN** `HTTP_PROXY_URL` is set to a working proxy **AND** `SOURCES` includes `olx` (or
  `SOURCES` is unset, defaulting to every known source), **WHEN** the scheduler runs a polling
  cycle, **THEN** the system SHALL fetch OLX listings for Kyiv through that proxy and merge
  matching results into the same notification stream as DOM.RIA/Rieltor, each alert tagged with
  `source = 'olx'` / `sourceLabel = 'OLX'` (mirroring `Listing.source`/`sourceLabel`,
  `src/sources/listing.interface.ts:44-49`).
- **WHEN** an OLX listing matches the user's one saved profile (price/area/rooms/operation, per
  the existing `matchesCriteria` safety net, `src/search-profiles/search-profile.model.ts:33-59`),
  **THEN** the system SHALL notify exactly as it does for DOM.RIA/Rieltor matches today (new
  listing → notify; price changed since last seen → notify; already seen, unchanged → no action).
- **WHEN** an OLX listing's numeric id collides with a DOM.RIA or Rieltor id, **THEN** the system
  SHALL still treat them as distinct listings, because dedup is namespaced `source:id`
  (`listingKey()`, `src/sources/listing.interface.ts:56-58`), not by raw id.
- This story is independently testable: with a working proxy and `DOMRIA_API_KEY`/other sources
  disabled, OLX alone must be able to drive a full fetch → match → notify → mark-seen cycle.

### US-2 (P1 — MVP): OLX prices are always shown in UAH, never mislabeled

As a user filtering by a UAH price range, I want every OLX price I see (and every price OLX
listings are filtered by) to be a true hryvnia figure, so a €120,000 sale listing is never read
as ₴120,000 and my budget filter isn't silently defeated.

Acceptance criteria:
- **WHEN** an OLX listing's source currency is UAH, **THEN** the system SHALL use that figure
  directly as the listing's price.
- **WHEN** an OLX listing's source currency is USD or EUR, **THEN** the system SHALL convert it
  to UAH using a current NBU (or equivalent authoritative) exchange rate before the listing is
  matched, stored, or displayed — mirroring the rule already enforced for DOM.RIA (`priceArr['3']`,
  `src/sources/site-specs.ts:72-84`) and Rieltor (NBU-equivalent parsed from the card,
  `specifications/knowledge/domain-notes.md:30-31`).
- **WHEN** an OLX listing's price/currency cannot be determined or converted (e.g. the rate
  source is unavailable), **THEN** the system SHALL treat the listing as priced `null`
  ("договірна") rather than guess — consistent with the existing rule that `matchesCriteria`
  excludes null-priced listings (`src/search-profiles/search-profile.model.ts:36-38`).
- **WHEN** the resulting `currency` field is reported anywhere user-facing, **THEN** it SHALL
  always read as UAH/грн for OLX listings that were shown at all (never a raw `$`/`€` figure
  presented as if it were hryvnia).

### US-3 (P1 — MVP): OLX never runs un-proxied, and never breaks the cycle when misconfigured

As the bot operator, I want OLX to be automatically inert unless a proxy is configured, so I
never accidentally hammer OLX with direct datacenter-IP requests (re-triggering the 403 block or
wasting retry budget) or take down the shared polling cycle for DOM.RIA/Rieltor users.

Acceptance criteria:
- **GIVEN** `SOURCES` includes `olx` **BUT** `HTTP_PROXY_URL` is unset or empty, **WHEN** the
  scheduler runs a cycle, **THEN** the system SHALL skip OLX for that cycle (return no OLX
  listings) rather than attempt a direct fetch, and SHALL log this once at startup as an
  operator-visible notice (not a silent no-op) — consistent with Constitution principle 9
  ("свідоме звуження, не тихі поломки").
- **WHEN** OLX's fetch (search page load, card parse, or currency conversion) fails for any
  reason (proxy down, Cloudflare still blocking, markup drift, rate conversion unavailable),
  **THEN** the system SHALL return `[]` for that cycle rather than throw, per the existing
  `ListingSource` contract (`src/sources/listing-source.interface.ts:9-27`), so DOM.RIA/Rieltor
  and every other profile's processing continues unaffected (Constitution principle 3).
- **WHEN** OLX is enabled and healthy, **THEN** it SHALL be subject to the same scraping
  etiquette already implemented generically in `HttpListingSource` — retry with exponential
  backoff, rotating User-Agent, small randomized pre-request delay, and per-unique-search fetch
  dedup across profiles (Constitution principle 6) — with no OLX-specific exemption.

### US-4 (P2): Operator can see OLX is on and working

As the bot operator, I want a low-effort way to confirm OLX is actually returning listings
through the proxy (not just silently returning `[]`), so I can trust the new coverage without
digging through debug logs.

Acceptance criteria:
- **WHEN** OLX successfully returns one or more parsed listings in a cycle, **THEN** the system
  SHALL log a debug-level line with the count and search parameters, mirroring the existing
  per-source debug log (`src/sources/http-listing-source.ts:97`).
- This story is not required for OLX listings to reach users (US-1 already covers that) — it is
  purely an operability/observability convenience, hence P2.

---

## Functional requirements

- **FR-001:** The system SHALL provide an OLX `SiteSpec` (id `olx`, label `OLX`) implementing the
  same `SiteSpec` contract as `domria`/`rieltor` (`src/sources/http-listing-source.ts:21-32`),
  producing `RawListing[]` with `id`, `title`, `price`, `currency`, `area`, `rooms`, `city`,
  `district` (when available), `url`, `imageUrl` (when available), and `isBusiness`.
- **FR-002:** The system SHALL parse OLX Kyiv rent/sale search results by reading the page's
  embedded `__NEXT_DATA__` JSON payload (OLX's Next.js data blob) rather than fragile DOM
  selectors, matching the parsing approach the pre-removal OLX adapter used.
- **FR-003:** The system SHALL add `'olx'` to `KNOWN_SOURCE_IDS` (`src/sources/listing.interface.ts:64`)
  and an entry `olx: 'OLX'` to `SOURCE_LABELS` (`src/sources/listing.interface.ts:67-70`), and
  SHALL register the `olx` `SiteSpec` in `SITE_SPECS` (`src/sources/site-specs.ts:200-203`), so
  that `SOURCES=olx` (or an unset `SOURCES`, which defaults to all known sources,
  `src/config/configuration.ts:74-79`) causes `sources.module.ts` to instantiate an
  `HttpListingSource` for OLX exactly as it does for the two existing sources.
- **FR-004:** THE SYSTEM SHALL build the OLX search URL from `SearchCriteria` for Kyiv only
  (rent vs. sale per `criteria.operation`; price range pushed into the URL query where OLX
  supports it), consistent with the bot-wide Kyiv-only scope (Constitution principle 9).
- **FR-005:** WHEN an OLX listing's price is published in UAH, THE SYSTEM SHALL use it directly.
  WHEN published in USD or EUR, THE SYSTEM SHALL convert it to UAH via a current NBU (or
  equivalent authoritative) exchange rate before the listing leaves the OLX adapter. WHEN no
  reliable rate/price can be resolved, THE SYSTEM SHALL set `price: null` and never emit a
  foreign-currency number under a UAH label.
- **FR-006:** THE SYSTEM SHALL gate OLX activation on a configured proxy: WHEN `olx` is in the
  enabled sources list AND `HTTP_PROXY_URL` is unset/empty, THE SYSTEM SHALL exclude OLX from the
  active source set for that run (equivalent to not fetching it) and SHALL emit a single
  startup-time log notice naming the reason, rather than attempting an un-proxied request.
- **FR-007:** THE SYSTEM SHALL route every OLX HTTP request through the existing proxy plumbing
  (`HttpListingSource`'s axios `proxy` config sourced from `cfg.proxyUrl` /
  `HTTP_PROXY_URL`, `src/sources/http-listing-source.ts:56-65,139-158`) — no OLX-specific proxy
  configuration path is introduced; OLX reuses the shared `HTTP_PROXY_URL` all sources already
  share.
- **FR-008:** THE OLX adapter's `fetchListings`/`fetch` implementation SHALL never throw for an
  expected failure (HTTP error, Cloudflare challenge page, empty/malformed `__NEXT_DATA__`,
  missing/failed currency conversion) and SHALL return `[]` in every such case, per the
  `ListingSource` contract (`src/sources/listing-source.interface.ts:9-27`).
- **FR-009:** THE SYSTEM SHALL apply the existing shared scraping etiquette (retry-with-backoff,
  rotating User-Agent, randomized pre-request delay, per-cycle fetch dedup via `requestKey`) to
  OLX with no bypass or relaxation, reusing `HttpListingSource`'s generic mechanics
  (`src/sources/http-listing-source.ts:105-134`) rather than a parallel implementation.
- **FR-010:** THE SYSTEM SHALL namespace OLX listings in the global dedup/seen store via
  `listingKey()` (`"olx:<id>"`, `src/sources/listing.interface.ts:56-58`) so an OLX listing can
  never collide with a same-numbered DOM.RIA or Rieltor listing in a profile's seen-hash.
- **FR-011:** THE SYSTEM SHALL leave `district` unset for OLX unless the source's admin-raion
  field can be mapped confidently — matching the DOM.RIA precedent of omitting an ambiguous
  neighbourhood-vs-raion field rather than mis-tagging it (`src/sources/site-specs.ts:96-98`).
- **FR-012:** THE SYSTEM SHALL treat OLX as one participant in the existing "one filter, all
  sources" model: no profile-level or wizard-level opt-in/opt-out per source is introduced — a
  saved profile is matched against OLX automatically whenever OLX is enabled/available, exactly
  as it already is against DOM.RIA/Rieltor.
- **FR-013:** THE SYSTEM SHALL document, in `.env.example`/README, that `SOURCES` may now include
  `olx`, that `HTTP_PROXY_URL` is required for OLX to be active, and that OLX carries the
  legal/GDPR caveats in Risks & Constraints below.
- **FR-014:** THE SYSTEM SHALL NOT persist any personally identifiable seller data scraped from
  OLX (no phone numbers, no seller names/handles) — only the same non-PII fields already stored
  for DOM.RIA/Rieltor listings (id, title, price, area, rooms, district, url, image, isBusiness),
  consistent with NFR-008 ("0 збережених персональних даних").

---

## Success Criteria (measurable)

- SC-001: With a working proxy and `SOURCES` including `olx`, a smoke test against a live Kyiv
  rent search returns **≥ 1** parsed OLX listing with a non-null `id`, `title`, and `url` through
  the configured proxy.
- SC-002: **0** foreign-currency (USD/EUR) OLX prices are surfaced or matched under a UAH label —
  every displayed/matched OLX price is either a genuine UAH figure or `null` ("договірна").
- SC-003: **100%** of OLX listings notified to users carry `source: 'olx'` / `sourceLabel: 'OLX'`
  and a `listingKey()` of the form `"olx:<id>"`, verified to never collide with a DOM.RIA/Rieltor
  key for a different listing sharing the same raw numeric id.
- SC-004: WHEN `HTTP_PROXY_URL` is unset/empty, OLX contributes **0** direct (non-proxied) HTTP
  requests to OLX.ua across a full polling cycle — verified by a unit test asserting the OLX
  source is excluded from the enabled set (or its fetch is a no-op) when no proxy is configured.
- SC-005: An OLX fetch failure (simulated 403, timeout, malformed `__NEXT_DATA__`, or failed rate
  lookup) results in **0** unhandled exceptions reaching `SourceRegistry`/the scheduler, and
  **0** impact on DOM.RIA/Rieltor results or other profiles' processing in the same cycle.
- SC-006: Test coverage for the new OLX adapter/currency-conversion code meets the project-wide
  gate of **≥ 80/80/80/70** (statement/branch/function/line), keeping the overall CI threshold
  green (NFR-009).
- SC-007: `README.md`/`.env.example` list `olx` as an available `SOURCES` value with an explicit
  "requires `HTTP_PROXY_URL`" note, reviewable by inspection (no code required to confirm).

---

## Out-of-scope / non-goals

- **lun.ua and flatfy.ua** remain excluded. Per ADR-0003 these are LUN-ecosystem aggregators that
  duplicate DOM.RIA/Rieltor inventory; their blocker is the same Cloudflare 403, but the decision
  to leave them out is about redundancy, not proxy access, and this feature does not revisit it.
- **birdrent.com / josti.com.ua** remain excluded — app-only services with no scrapeable web
  catalog (ADR-0003); no proxy changes that.
- **Non-Kyiv cities.** OLX search/parsing in this feature is Kyiv-only, matching the bot-wide
  scope (Constitution principle 9); no new city-geo mapping is introduced.
- **Per-source filter opt-in/opt-out.** The "one filter per user" model is unchanged; users
  cannot choose to include/exclude OLX specifically from their profile.
- **District/owner-only wizard steps.** Unaffected by this feature; OLX's `district`/`isBusiness`
  fields (when derivable) feed the existing client-side `matchesCriteria` safety net exactly as
  DOM.RIA's and Rieltor's already do, but no new wizard step is added.
- **Proxy procurement/vendor selection.** Choosing, provisioning, or paying for a specific
  residential/rotating proxy provider is an infrastructure decision outside this spec; the spec
  assumes `HTTP_PROXY_URL` points at a working one.
- **Historical price tracking for OLX.** Same bot-wide limit as existing sources — only
  current-vs-last-seen price comparison, no time-series/history store.
- **Guaranteed evasion of future anti-bot changes.** This feature restores OLX access under
  today's Cloudflare configuration via proxy; it does not guarantee continued access if OLX
  changes its bot-detection approach.

---

## Risks & constraints

- **Legal / ToS gray area.** Fetching OLX.ua through a proxy specifically to bypass a Cloudflare
  bot-fight challenge is a ToS gray area — OLX's terms generally prohibit automated access, and
  the whole point of a residential/rotating proxy here is to route around a block that exists
  precisely to stop that. This is materially different from Rieltor (no active block bypassed)
  and DOM.RIA (official, key-based API). Operating this in a private, non-commercial, small
  allowlisted group reduces but does not eliminate this risk; a public launch or any monetization
  of this feature is an explicit trigger for legal review before shipping (mirrors ADR-0003's own
  flag).
- **Data-controller / GDPR posture.** The operator remains a data controller for whatever OLX
  data is stored. This feature must not widen the data footprint: continue storing only
  non-PII listing fields (id, title, price, area, rooms, district, url, image, isBusiness) —
  never phone numbers, seller names, or chat/contact handles that OLX's pages may expose
  (FR-014, NFR-008).
- **Proxy cost and reliability.** A residential/rotating proxy is typically a paid, metered
  service (cost scales with request volume/bandwidth) and can itself be flaky, rate-limited, or
  eventually detected/blocked by Cloudflare — unlike the free, official DOM.RIA API or the
  currently-unblocked Rieltor HTML. Budget and monitor accordingly; a proxy outage must degrade
  to "OLX silently contributes nothing this cycle" (per US-3), never a cycle-wide failure.
- **Currency conversion freshness.** An NBU (or equivalent) exchange rate is a snapshot; a
  listing's displayed UAH price is only as fresh as the rate lookup at fetch time. This mirrors
  the acceptable-imprecision already implicit in DOM.RIA/Rieltor's own currency handling and is
  not a new risk class, but it is worth naming since OLX (unlike Rieltor rent) frequently lists
  in USD/EUR for sale listings.
- **Markup drift.** OLX's `__NEXT_DATA__` shape is undocumented and can change without notice
  (same caveat the codebase already states for Rieltor's HTML, `src/sources/site-specs.ts:9-11`).
  The adapter must fail closed (`[]`, not a throw) on any shape mismatch (FR-008).
- **Rate-limit sensitivity.** Even proxied, OLX may itself rate-limit; the existing shared
  scraping etiquette (backoff, jitter, per-cycle dedup) applies unmodified (FR-009) — no
  OLX-specific increase in request aggressiveness is introduced by this feature.

---

## Glossary

| Term | Meaning in this spec |
|---|---|
| **OLX** | OLX.ua, a Ukrainian classifieds site; the source being re-enabled by this feature. |
| **Proxy-gated** | A source that is only included in the active fetch set when `HTTP_PROXY_URL` is configured; otherwise it contributes no requests and no listings for that cycle. |
| **`__NEXT_DATA__`** | A JSON payload OLX's Next.js-rendered pages embed in the HTML, containing the search results as structured data rather than markup to be scraped with selectors. |
| **NBU rate** | An exchange rate published by the National Bank of Ukraine (or an equivalent authoritative source), used to convert a USD/EUR-listed price to its UAH equivalent. |
| **`SiteSpec`** | The declarative/imperative adapter contract every source (including the restored OLX one) implements (`src/sources/http-listing-source.ts:21-32`). |
| **`listingKey()`** | The `"source:id"` global dedup key preventing an OLX id from colliding with a same-numbered DOM.RIA/Rieltor id (`src/sources/listing.interface.ts:56-58`). |
| **One filter, all sources** | The existing model (unchanged by this feature): one saved profile per user is matched against every enabled source, OLX included once active. |
| **Fail closed (source)** | An adapter that returns `[]` on any expected failure — malformed payload, proxy failure, missing rate — rather than throwing and disrupting the shared polling cycle. |
