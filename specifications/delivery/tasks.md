# Delivery Tasks — Proxy-Enabled OLX Source

Source docs: [`specifications/product/specs/001-feature/spec.md`](../product/specs/001-feature/spec.md)
(US-1..4, FR-001..014, SC-001..007) · [`specifications/architecture/plan.md`](../architecture/plan.md)
§"Planned feature: OLX via residential proxy" · ADRs
[0005](../architecture/decisions/0005-olx-proxy-gated-source.md) (proxy gate) ·
[0006](../architecture/decisions/0006-nbu-currency-converter.md) (NBU converter) ·
[0007](../architecture/decisions/0007-olx-next-data-parser.md) (`__NEXT_DATA__` parser).

This is almost entirely a **restore** of code removed in PRs #23/#19 (recoverable from git before
commit `9c61511`), **re-fitted** to the current `SiteSpec`/`SiteContext` contract — most notably,
the historical OLX adapter used the *declarative* `buildUrl`/`parse` path and never converted
currency; the target design (ADR-0006) uses the *imperative* `fetch` path instead, specifically so
it can `await ensureRates(...)` before mapping. Treat the old code as raw material, not a drop-in.
Scope is **OLX only** (not lun/flatfy — ADR-0003 excludes them as duplicates, unaffected here). The
scheduler, dedup, `matchesCriteria`, wizard, and Redis data model are **not** touched by any task
below.

Tasks are ordered by dependency; each is independently reviewable and ≈ half a day or less.

---

## T-001 — Add `requiresProxy?: boolean` to the `SiteSpec` contract

**Change:** `src/sources/http-listing-source.ts:21-32` — add an optional, declarative
`requiresProxy?: boolean` field to the `SiteSpec` interface (JSDoc: "source is excluded from the
active set when no `HTTP_PROXY_URL` is configured"). No behavioural code changes in this file;
`domria`/`rieltor` simply don't set it.

**Acceptance criteria:**
- `SiteSpec` gains the field; it is optional so existing specs (`domria`, `rieltor`,
  `SITE_SPECS`) compile and behave unchanged.
- No `id === 'olx'` (or any id-based) special-casing anywhere — the flag is generic, reusable by
  any future proxy-blocked source (per ADR-0005 "Decision" §2).
- Full existing suite stays green (`npm test`); no new test file needed for a pure type addition,
  but `http-listing-source.spec.ts`'s existing specs (which don't set the field) must still pass.

**Traceability:** FR-006, FR-007 (contract half) · ADR-0005.

---

## T-002 — Gate proxy-required sources in `sources.module.ts` + startup notice

**Change:** `src/sources/sources.module.ts:14-25` — in the `listingSourcesProvider` factory, skip
instantiating an `HttpListingSource` for any spec where `spec.requiresProxy && !cfg.proxyUrl`, and
emit exactly one startup-time `Logger` notice naming the reason (alongside the existing
`sources=[...]` log line). Because the source never enters `LISTING_SOURCES`, `SourceRegistry` and
the scheduler never see it — the exclusion is structural, not a runtime guard inside the fetch path
(per ADR-0005 §3, rejecting the "gate at runtime" alternative).

To make this independently unit-testable (module factories aren't directly unit-testable, and
`*.module.ts` is excluded from the coverage-collection glob in `jest.config.js`), extract the
gating decision into a small exported pure function (e.g. `buildListingSources(specs, cfg, logger)`
in `sources.module.ts` or a co-located helper) that the Nest provider factory calls — this keeps the
behavioural logic itself covered and directly testable even though the module wrapper is exempt.

**Acceptance criteria:**
- With a `requiresProxy: true` fake spec and `cfg.proxyUrl` unset/empty → the spec is excluded from
  the returned sources array, and exactly one notice is logged naming the excluded source id and the
  reason ("no HTTP_PROXY_URL").
- Same fake spec with `cfg.proxyUrl` set → the spec **is** instantiated into an `HttpListingSource`.
- A non-`requiresProxy` spec (e.g. `domria`/`rieltor`-shaped fakes) is unaffected by an unset
  `cfg.proxyUrl` — gate applies only to flagged specs.
- A test asserting **zero HTTP calls**: build the sources with no proxy configured, then confirm the
  excluded source is simply absent from the returned array (so nothing downstream can ever call
  `fetchListings` on it) — this is the mechanism SC-004 relies on, not a runtime network-call
  assertion.
- New/updated test file (e.g. `src/sources/sources.module.spec.ts` or wherever the extracted helper
  lives) covering all of the above.

**Traceability:** FR-006, FR-007, US-3 · SC-004 · ADR-0005.

---

## T-003 — Restore the generic `__NEXT_DATA__` parser cluster

**Change:** new `src/sources/next-data.util.ts` — restore, source-agnostic:
- `extractNextData(html): unknown | null` — pull + `JSON.parse` the `<script id="__NEXT_DATA__">`
  tag (cheerio), returning `null` on a missing tag or a `JSON.parse` throw (never throws itself).
- `deepFindOffers(node, depth?, out?): any[]` — defensive deep-walk collecting objects that look
  like listing offers (id + title + url heuristic, matching the pre-#23 shape), bounded by a
  depth/visited guard so a hostile or huge payload can't hang the walk (per ADR-0007 §2).

Kept deliberately source-agnostic/pure so any future Next.js source can reuse it (per ADR-0007 §1)
— no OLX-specific logic in this file.

**Acceptance criteria:**
- `extractNextData`: valid fixture → parsed object; missing/empty script tag → `null`; malformed
  JSON inside the tag → `null` (no throw).
- `deepFindOffers`: finds offers nested at various depths in a sample tree; a node that doesn't look
  like an offer (missing id/title/url) is not collected; a deeply nested or self-referential/huge
  input does not hang or throw (depth guard exercised by a test).
- New `src/sources/next-data.util.spec.ts` covering all of the above; inline HTML/JSON fixtures in
  the spec file (matching this repo's existing convention, e.g. `parsing.util.spec.ts`'s inline
  `realtorCard` strings) — no new fixture-file directory.

**Traceability:** FR-002, FR-008 · ADR-0007.

---

## T-004 — Restore the NBU currency converter (`currency.ts`)

**Change:** new `src/sources/currency.ts` — restore:
- `toUah(amount: number | null, currency: string, rates: Record<string, number>): number | null` —
  pure: `UAH`/`ГРН` → passthrough (rounded); known foreign code with a rate → `amount * rate`
  (rounded); unknown/missing rate or null amount → `null` (never guesses, never returns a foreign
  figure unconverted).
- `ensureRates(getJson: (url: string) => Promise<any>): Promise<Record<string, number>>` — fetches
  the NBU public JSON endpoint, populates a module-level `uahRates` cache with a ~24h TTL (per
  ADR-0006 §2 "aligns with NFR-005/NFR-006 request frugality"), and **degrades gracefully**: a
  `getJson` rejection leaves the cache at whatever it already held (empty on a cold start) rather
  than throwing.
- A test-only reset hook (e.g. `resetRatesCache()`) so tests can force a cold cache without relying
  on real elapsed time.

**Acceptance criteria:**
- `toUah`: UAH passthrough; USD/EUR converted via a mock rate table; unknown currency code or a rate
  table missing the needed code → `null`; `amount == null` → `null`.
- `ensureRates`: given a `getJson` that resolves an NBU-shaped array → `uahRates` populated with the
  expected `{ CC: rate }` entries (plus `UAH: 1`); given a `getJson` that **throws** → the cache stays
  at its prior state (empty on cold start) and a subsequent `toUah` call for a foreign currency
  returns `null` while a UAH amount is unaffected.
- Cache reuse within the TTL window: a second `ensureRates` call inside ~24h does **not** re-invoke
  `getJson` (asserted via a mock call-count, using the reset hook + a controllable/injected clock or
  equivalent test technique — no real 24h wait).
- Never throws under any input (fully covered by branch coverage for the gate's cost of ~80/80/80/70).
- New `src/sources/currency.spec.ts` covering all of the above.

**Traceability:** FR-005 (currency half) · SC-002 · ADR-0006.

---

## T-005 — OLX-specific parse cluster: URL builder, `mapOffer`, `parseCards`/`nextDataThenCards`

**Change:** in `src/sources/site-specs.ts` (alongside `rieltor`/`domria`, per ADR-0007 §1), add,
OLX-specific, reusing `toInt`/`toFloat`/`absoluteUrl` from `parsing.util.ts` and `extractNextData`/
`deepFindOffers` from T-003's `next-data.util.ts`:
- An OLX Kyiv rent/sale **search URL builder** from `SearchCriteria` (`operation` → rent vs sale
  path segment; price range pushed into the query where OLX's URL supports it; Kyiv-only, per
  Constitution principle 9 / FR-004).
- `mapOffer(offer, baseUrl, rates): RawListing | null` — maps one raw `__NEXT_DATA__` offer object
  to a `RawListing`, delegating price normalization to T-004's `toUah(amount, currency, rates)`
  (FR-005). Maps **only** the non-PII fields named in FR-001/FR-014 (id, title, price, currency,
  area, rooms, city, district when confident, url, imageUrl, isBusiness) — never a seller
  phone/name/handle field the payload may also carry (FR-014). Leaves `district` unset unless an
  admin-raion field can be mapped confidently, matching the DOM.RIA precedent
  (`src/sources/site-specs.ts:96-98`; FR-011). Returns `null` (skipped, not thrown) for a
  malformed/incomplete offer (missing id/title/url).
- `parseCards`/`nextDataThenCards` orchestration: try `extractNextData` → `deepFindOffers` →
  `mapOffer` first; optionally fall back to a DOM-card cheerio parse only as a last resort (per
  ADR-0007 §3, never the primary path).

**Acceptance criteria:**
- URL builder: rent vs sale path segment differs by `criteria.operation`; price range appears in the
  query when set and is omitted when not; output is always a Kyiv OLX URL (no city parameterization).
- `mapOffer`: happy-path offer → all documented fields mapped correctly, including rooms/area/url/
  imageUrl; a UAH-priced offer passes its price straight to `toUah` (passthrough); a USD/EUR-priced
  offer is converted via a mock rate table; an offer missing a resolvable rate → `price: null`; a
  malformed offer (no id/title/url) → `null` return, not a throw; a sample offer object carrying a
  seller-phone-like field is asserted to **never** appear in the mapped `RawListing`.
- `nextDataThenCards`: given a fixture HTML containing a valid `__NEXT_DATA__` blob → returns mapped
  offers; given HTML with no/malformed `__NEXT_DATA__` → falls through without throwing (returns `[]`
  if no fallback, or the fallback's best-effort result).
- Tests added to `src/sources/site-specs.spec.ts` (new `describe('OLX spec')` / helper-level block)
  mirroring the existing Rieltor/DOM.RIA test structure in that file.

**Traceability:** FR-001, FR-002, FR-004, FR-011, FR-014 · ADR-0006, ADR-0007.

---

## T-006 — OLX `SiteSpec` (imperative `fetch`), wired end-to-end

**Change:** in `src/sources/site-specs.ts`, add the OLX `SiteSpec` object:
`{ id: 'olx', label: 'OLX', requiresProxy: true, requestKey, fetch }` (do **not** register it in
`SITE_SPECS` yet — that's T-007). `fetch(ctx, criteria)`:
1. Build the Kyiv rent/sale URL from `criteria` (T-005's builder).
2. `await ensureRates(ctx.getJson)` (T-004) — resolves the current NBU rate table before any
   mapping happens (ADR-0006 §3: the imperative path exists specifically so this `await` is
   possible).
3. `ctx.getHtml(url)` — reuses the shared proxied/retried/UA-rotated/jittered HTTP client; no
   OLX-specific HTTP path (FR-007, FR-009).
4. `nextDataThenCards(html, baseUrl, rates)` (T-005) → mapped `RawListing[]`.
5. On success with ≥1 listing, log one debug line with the count + search params (mirroring
   `http-listing-source.ts:97`; US-4).
6. Any failure at any step (rate load rejects, `getHtml` throws, parse yields nothing usable) is
   caught and the whole `fetch` resolves to `[]` — never throws (FR-008, US-3, SC-005).

`requestKey(criteria, cfg)` returns a key varying by the same fields the URL depends on (Kyiv +
operation + price range at minimum), so profiles differing only in unrelated fields (area/rooms)
share one OLX fetch per cycle (FR-009 dedup).

**Acceptance criteria:**
- Happy path: given a mocked `ctx.getJson` (NBU rates) and `ctx.getHtml` (fixture HTML), `fetch`
  returns the expected mapped listings.
- `ensureRates`'s underlying `getJson` rejecting → `fetch` resolves to `[]`, no throw.
- `ctx.getHtml` rejecting (simulated network/Cloudflare failure) → `fetch` resolves to `[]`, no
  throw.
- Malformed/empty `__NEXT_DATA__` in the fetched HTML → `fetch` resolves to `[]` (or whatever
  `nextDataThenCards`'s fallback yields), no throw.
- On a successful fetch with ≥1 listing, a debug-level log line is emitted including the listing
  count (assert via a mocked `ctx.logger.debug`).
- `requestKey` differs when `priceMin`/`priceMax`/`operation` differ, and is identical for two
  criteria differing only in `areaMin`/`rooms` (client-side-only fields) — proving the dedup
  contract (mirrors the existing DOM.RIA `requestKey` test in `site-specs.spec.ts:98-104`).
- Tests added to `src/sources/site-specs.spec.ts`.

**Traceability:** FR-001, FR-004, FR-005, FR-007, FR-008, FR-009 · US-1, US-3, US-4 · SC-005 ·
ADR-0005, ADR-0006, ADR-0007.

---

## T-007 — Register `olx` in `KNOWN_SOURCE_IDS` / `SOURCE_LABELS` / `SITE_SPECS`

**Change:**
- `src/sources/listing.interface.ts:64` — add `'olx'` to `KNOWN_SOURCE_IDS`.
- `src/sources/listing.interface.ts:67-70` — add `olx: 'OLX'` to `SOURCE_LABELS`.
- `src/sources/site-specs.ts:200-203` — register the T-006 `olx` `SiteSpec` object in `SITE_SPECS`.

This is the switch that makes `SOURCES=olx` (or an unset `SOURCES`, defaulting to every known
source per `src/config/configuration.ts:74-79`) recognised rather than silently dropped as an
unknown id, and makes the T-002 proxy gate apply to a real spec end-to-end.

**Acceptance criteria:**
- `configuration.spec.ts`: `SOURCES=olx` is retained in `cfg.sources.enabled` (not dropped as
  unknown); an unset `SOURCES` env defaults to include `olx` alongside `domria`/`rieltor`.
- `listing.interface.spec.ts`: `SOURCE_LABELS.olx === 'OLX'`; `KNOWN_SOURCE_IDS` includes `'olx'`.
- With `cfg.proxyUrl` set and `SOURCES` including `olx`, the real `SITE_SPECS.olx` entry is
  instantiated into `LISTING_SOURCES` (end-to-end proof that T-002's gate + T-006's spec compose
  correctly) — extend or add to the T-002 gating test using the real registered spec instead of a
  fake one, or add an equivalent assertion in `sources.module.spec.ts`.
- Explicit non-regression check (FR-012): no changes to `search-profiles/`, the `/newsearch` wizard,
  or `SearchCriteria` — a saved profile is matched against `olx` automatically once enabled, with no
  new per-source opt-in surfaced anywhere. State this as a reviewed acceptance item (diff review),
  not a new test.

**Traceability:** FR-003, FR-012 · ADR-0005.

---

## T-008 — OLX end-to-end fixture test (USD + UAH offers, tagging, dedup-key safety)

**Change:** test-only — no production code. A dedicated cross-cutting test exercising the full
chain built in T-003 through T-007 together, since this scenario can only be written once every
piece exists.

**Acceptance criteria:**
- A saved `__NEXT_DATA__`-shaped HTML fixture (inline in the spec file, per this repo's convention)
  containing several offers, including **at least one USD-priced** and **at least one UAH-priced**
  offer.
- Through `SITE_SPECS.olx.fetch` (with mocked `ctx.getHtml` returning the fixture and mocked
  `ctx.getJson` returning a mock NBU rate table): id/title/url/area/rooms are mapped correctly for
  each offer; the UAH offer's price passes through unchanged; the USD offer's price is converted to
  its грн equivalent per the mock rate (US-1, US-2, FR-001, FR-005).
- Wrapping the same fixture through `HttpListingSource.fetchListings` (as the scheduler would): each
  resulting `Listing` carries `source: 'olx'` and `sourceLabel: 'OLX'`.
- `listingKey()` for an OLX listing is of the form `"olx:<id>"`, and is asserted to differ from the
  `listingKey()` of a same-numbered fake DOM.RIA/Rieltor listing (constructing both keys and
  asserting inequality) — proving FR-010's no-collision guarantee (SC-003).
- No PII field from the fixture (a seller phone/name field deliberately included in the fixture)
  ends up in any mapped `Listing` (extends FR-014's guarantee to the full pipeline).
- This test stands in for spec SC-001's live smoke-test requirement in CI (a fixture-based
  equivalent, since a real proxy + live OLX call isn't a unit-test concern); note in the test file
  or PR description that an optional manual smoke check against live OLX (with a real
  `HTTP_PROXY_URL`) is recommended once a proxy is provisioned, but is not part of the automated
  suite.

**Traceability:** US-1, US-2, FR-001, FR-005, FR-010 · SC-001, SC-002, SC-003.

---

## T-009 — Docs: `README.md` + `.env.example`

**Change:**
- `.env.example` — update the `SOURCES` comment (currently "Available: domria, rieltor",
  line ~37) to include `olx`, and add a note next to `HTTP_PROXY_URL` (currently commented out,
  line ~48) that it is **required** for `olx` to be active.
- `README.md`:
  - The sources table (`README.md:98-101`) gets an `olx` row (id/site/data-shape note: parses
    `__NEXT_DATA__`, requires proxy).
  - The "Dropped after evaluation" line (`README.md:103-105`) is updated: OLX is no longer dropped —
    it's re-enabled, proxy-gated; only lun.ua/flatfy.ua/birdrent.com/josti.com.ua remain excluded,
    with their existing reasons unchanged.
  - The "Configuration reference" table (`README.md:293-311`) — `SOURCES` default/notes row
    (line 305) mentions `olx` as an available value; `HTTP_PROXY_URL` row (line 308) notes it's
    required specifically for `olx`.
  - The GitHub Actions "Runtime mode & sources" section (`README.md:253-265`) — note that setting
    the `SOURCES` repo Variable to include `olx` requires the `FLAT_HUNTER_HTTP_PROXY_URL` secret to
    also be set, or OLX stays inert (per T-002's startup notice).
  - "Known limitations / next steps" (`README.md:342-344`) — updated to reflect OLX no longer being
    purely blocked-without-recourse (now gated-and-working behind a proxy), while lun/flatfy remain
    excluded for the ADR-0003 duplication reason, unaffected.
  - Add the ToS/GDPR caveat from the spec's Risks & constraints (private/non-commercial/allowlisted
    use only; legal review trigger before any public launch or monetization; no PII widening — same
    non-PII fields as DOM.RIA/Rieltor) near the `olx` mentions, so it's discoverable without reading
    the ADRs.

**Acceptance criteria:**
- `SOURCES=olx` is listed as an available value in both `.env.example` and `README.md`, each paired
  with an explicit "requires `HTTP_PROXY_URL`" note (reviewable by inspection — no code required).
- The ToS/GDPR caveat is present and reads consistently with ADR-0005's "Consequences" section (no
  new claims beyond what the spec/ADR already state).
- No stale claims left behind: nothing still says OLX is dropped/unavailable/needs-a-proxy-to-even-
  exist-as-code once this task lands.

**Traceability:** FR-013 · SC-007.

---

## T-010 — Final verification: build, full suite, coverage gate, `spec-forge validate`

**Change:** none (verification only).

**Acceptance criteria:**
- `npm run build` succeeds (no TypeScript errors).
- `npm test` — full suite green, including every test added in T-002 through T-008.
- `npm run test:cov` — coverage gate held at **80/80/80/70** (statements/lines/functions/branches
  per `jest.config.js`'s `coverageThreshold`), globally, with the new files (`next-data.util.ts`,
  `currency.ts`, the OLX additions to `site-specs.ts`) included in `collectCoverageFrom` and meeting
  the bar (SC-006, NFR-009).
- `npm run lint` clean.
- `spec-forge validate` passes (repo's spec-forge phase gate, per `.spec-forge/state.json`).
- Re-read the traceability check below and confirm every row is actually satisfied by the merged
  code + tests, not just planned.

**Traceability:** SC-006 · NFR-009 (project-wide CI gate, Constitution principle 10).

---

## Traceability check

Every FR-001..014 and SC-001..007 maps to at least one task:

| Requirement | Task(s) |
|---|---|
| FR-001 | T-005, T-006, T-008 |
| FR-002 | T-003, T-005 |
| FR-003 | T-007 |
| FR-004 | T-005, T-006 |
| FR-005 | T-004, T-005, T-006, T-008 |
| FR-006 | T-001, T-002 |
| FR-007 | T-001, T-002, T-006 |
| FR-008 | T-003, T-006 |
| FR-009 | T-006 |
| FR-010 | T-008 |
| FR-011 | T-005 |
| FR-012 | T-007 |
| FR-013 | T-009 |
| FR-014 | T-005, T-008 |
| SC-001 | T-008 (fixture-based equivalent; see T-008's acceptance criteria for the live-smoke caveat) |
| SC-002 | T-004, T-005, T-008 |
| SC-003 | T-008 |
| SC-004 | T-002 |
| SC-005 | T-003, T-006 |
| SC-006 | T-010 |
| SC-007 | T-009 |

No FR/SC is left uncovered; no task exists without at least one FR/SC/ADR anchor.
