# ADR-0006: Restore an NBU currency converter to normalize OLX $/€ → грн

**Status:** proposed
**Date:** 2026-07-09

> Scope: the planned "Proxy-Enabled OLX Source" feature
> ([`specifications/product/specs/001-feature/spec.md`](../../product/specs/001-feature/spec.md)),
> US-2 / FR-005 / SC-002. Depends on ADR-0005 (OLX re-enabled).

## Context

Constitution principle 5 requires every price in грн, converted using **the rate the source itself
provides**, and forbids ever labelling a raw foreign figure as грн (a ~×40 error). The two live
sources satisfy this from their own payloads:

- **DOM.RIA** exposes the same price in all three currencies via `priceArr`, key `"3"` = грн
  (`src/sources/site-specs.ts:78-84`).
- **Rieltor** puts an NBU hryvnia equivalent in the price-title `title` attribute for sale listings
  (`src/sources/parsing.util.ts:76-85`; `specifications/knowledge/domain-notes.md:30-31`).

**OLX is the exception:** its `__NEXT_DATA__` gives a price and a currency code (`UAH`/`USD`/`EUR`)
but **no source-provided UAH equivalent** for foreign-currency listings — and OLX sale listings are
frequently in $/€ (domain-notes.md:5-8). So OLX cannot satisfy principle 5 from its own data alone.
An NBU-rate converter existed in the pre-#23 OLX adapter (`currency.ts`, exporting `uahRates` +
`toUah`) and was removed together with OLX and the lun source; it is recoverable from git history.

This is therefore a **deliberate, narrow deviation from principle 5's "source-provided rate"** — and
under principle 4 ("порушувати можна лише через явний ADR") that deviation needs this ADR.

## Decision

Restore an **NBU (National Bank of Ukraine) exchange-rate converter**, scoped to OLX, that normalizes
$/€ prices to грн before a listing leaves the OLX adapter — and **fails closed to `price: null`**
("договірна") whenever a reliable rate can't be resolved.

1. **Location.** Restore `src/sources/currency.ts` exporting a pure `toUah(amount, currency, rates)`
   and a cached `ensureRates(getJson)` that populates a module-level `uahRates` map. Rates come from
   the NBU public JSON endpoint (`bank.gov.ua/NBUStatService/.../exchange?json`; `cc` + `rate`
   fields). `ensureRates` takes a `getJson` function (injected — in production, `ctx.getJson` from
   `SiteContext`, `src/sources/http-listing-source.ts:9-15`) so it inherits retry/UA/timeout and
   stays trivially mockable in tests.
2. **Freshness / cost.** Rates are cached with a ~24h TTL (NBU publishes once per business day), so
   OLX adds at most ~1 rate fetch per day, not one per cycle (aligns with NFR-005/NFR-006 request
   frugality). The cache is in-memory (per process), consistent with ADR-0001's already-accepted
   in-memory-cache trade-off (resets on restart, refills on the next OLX cycle).
3. **Wiring into OLX.** The OLX spec uses the **imperative `fetch` path** (like DOM.RIA), not the
   declarative `parse`, so it can `await ensureRates(ctx.getJson)` *before* mapping offers and pass
   the resolved rates into the pure offer-mapping helpers. Rationale: `parse(payload, cfg)` is
   synchronous and cannot await an HTTP rate load; the imperative path makes the rate dependency
   explicit and guarantees a rate is present (or the listing goes `null`) on the very first cycle,
   rather than every OLX price being `null` until a background warm-up completes.
4. **Rules (mirroring the constitution and the other two sources):**
   - currency `UAH` → use the figure directly (no rate needed).
   - currency `USD`/`EUR` → multiply by the cached NBU rate → грн.
   - rate missing/unfetchable, or currency/price unparseable → `price: null`, and the listing is
     then excluded by the existing `matchesCriteria` null-guard
     (`src/search-profiles/search-profile.model.ts:36-38`). **Never** emit a foreign number under a
     грн label (SC-002).
5. The converter is written generically (amount + ISO currency in, грн out) so it is **reusable** if
   another foreign-priced source is added later; today OLX is its only caller.

## Consequences

- ➕ OLX prices are true hryvnia figures or honestly `null`, upholding principle 5 despite OLX not
  providing its own rate (US-2, SC-002).
- ➕ Cheap and resilient: ≤ ~1 NBU call/day; NBU is not Cloudflare-blocked, so it works without the
  proxy even while OLX itself needs one. An NBU outage degrades gracefully — foreign prices go
  `null`, UAH prices are unaffected, the cycle never fails (NFR-004).
- ➖ **Snapshot imprecision.** A displayed UAH figure is only as fresh as the last rate fetch (up to
  ~24h old). This is the same acceptable imprecision already implicit in DOM.RIA/Rieltor currency
  handling (spec §Risks); named here because OLX leans on it more (frequent $/€ sale listings).
- ➖ **Deviation from "source-provided rate."** OLX uniquely relies on an *external* rate. Bounded by:
  it is the only such source; the rate has a hard TTL; and it fails closed rather than guessing.
- ➖ First OLX cycle after a restart pays one extra NBU round-trip to warm `uahRates` (then cached).

## Alternatives considered

- **Drop all non-UAH OLX listings** (treat any $/€ price as `null`). Rejected: OLX sale inventory is
  mostly $/€ (domain-notes.md:5-8), so this would gut OLX's coverage — defeating the point of adding
  it — even though the fail-closed path already does exactly this as a *fallback*.
- **Reuse a source-provided rate, like DOM.RIA/Rieltor.** Not possible: OLX's `__NEXT_DATA__` carries
  no UAH equivalent for foreign listings. There is no in-payload rate to reuse.
- **A third-party FX API instead of NBU.** Rejected: NBU is the authoritative, free, no-key Ukrainian
  reference already named across the codebase (DOM.RIA's `priceArr[3]` and Rieltor's "курс НБУ" both
  track it), keeping OLX consistent with the two live sources.
- **Persist rates in Redis instead of in-memory.** Deferred: in-memory matches ADR-0001's accepted
  trade-off and a stale-then-refetch cache is adequate for a once-daily rate; a persistent watermark
  is a possible future change, not needed now.
