# ADR-0007: Parse OLX via its `__NEXT_DATA__` JSON blob, not DOM selectors

**Status:** proposed
**Date:** 2026-07-09

> Scope: the planned "Proxy-Enabled OLX Source" feature
> ([`specifications/product/specs/001-feature/spec.md`](../../product/specs/001-feature/spec.md)),
> FR-001 / FR-002. Depends on ADR-0005 (OLX re-enabled) and ADR-0006 (currency).

## Context

OLX.ua is a Next.js app: each search page embeds its results as a JSON payload in a
`<script id="__NEXT_DATA__">` tag, rather than only as rendered markup. The pre-#23 OLX adapter
parsed this blob through a small helper cluster — `extractNextData` (pull + `JSON.parse` the script
tag), `deepFindOffers` (walk the payload to the offers array, whose exact nesting is undocumented
and drifts), `mapOffer` (one raw offer → `RawListing`), and `parseCards` / `nextDataThenCards` (the
top-level parse, with a DOM-card fallback). That cluster was removed with OLX in ADR-0003 and is
recoverable from git history (prior to commit `9c61511`). The alternative — scraping the visible
`.card` DOM with cheerio, as Rieltor does (`src/sources/parsing.util.ts:36-115`) — is available but
weaker for OLX specifically, because OLX ships hashed CSS-module class names that rotate on frontend
redeploys (the same footgun already noted for Rieltor, domain-notes.md:32).

Choosing the parsing surface is a resilience decision with real consequences (FR-002 mandates the
`__NEXT_DATA__` approach), so per Constitution principle "everything significant → an ADR" it is
recorded here rather than left implicit in the plan.

## Decision

Restore the **`__NEXT_DATA__` JSON parser cluster** as OLX's primary parse path.

1. **Where it lives.** The *generic* Next.js helpers — `extractNextData` (script-tag → parsed JSON)
   and `deepFindOffers` (defensive deep-walk to the offers array) — go in a dedicated
   `src/sources/next-data.util.ts`, kept source-agnostic so any future Next.js site reuses them. The
   *OLX-specific* pieces — the search-URL builder, `mapOffer` (offer → `RawListing`, delegating price
   normalization to ADR-0006's `toUah`), and the `parseCards`/`nextDataThenCards` orchestration —
   live alongside the OLX `SiteSpec` in `src/sources/site-specs.ts`, mirroring how `rieltor`/`domria`
   are organised (`site-specs.ts:30-36,121-197`), and reuse the shared `toInt`/`toFloat`/`absoluteUrl`
   helpers (`src/sources/parsing.util.ts:11-25`).
2. **Fail closed on every shape mismatch.** Missing/empty script tag, `JSON.parse` throw, offers
   array not found, or an individual offer missing required fields → that offer is skipped and the
   parse returns whatever it *could* map (or `[]`) — it never throws, honouring the `ListingSource`
   contract (`src/sources/listing-source.interface.ts:9-27`) and FR-008. `deepFindOffers` is
   bounded (depth/visited guard) so a hostile or huge payload can't hang the walk.
3. **`district` conservatism.** Leave OLX `district` unset unless an admin-raion field maps
   confidently, matching the DOM.RIA precedent of omitting an ambiguous neighbourhood-vs-raion field
   (`src/sources/site-specs.ts:96-98`; FR-011).
4. **No PII in `mapOffer`.** Map only the non-PII fields (id/title/price/currency/area/rooms/city/
   district/url/imageUrl/isBusiness); never read seller phone/name/handle fields the payload may
   also contain (FR-014, NFR-008).

## Consequences

- ➕ Parsing structured JSON is far more stable than hashed-class DOM scraping: OLX can restyle its
  frontend without breaking the adapter, as long as the data contract holds.
- ➕ The generic `next-data.util.ts` is reusable for any future Next.js source, and is pure/sync →
  cheap to unit-test against a saved fixture.
- ➖ **Undocumented, drift-prone shape.** `__NEXT_DATA__`'s nesting is not a published contract and
  can change without notice (spec §Risks — Markup drift). The defensive `deepFindOffers` +
  fail-closed rule (`[]`, not throw) contains the blast radius, but a shape change still means "OLX
  quietly returns nothing" until the traversal is re-tuned against the live payload — the same
  best-effort caveat the codebase already states for Rieltor (`site-specs.ts:9-11`).
- ➖ Two files touched per OLX field change (generic util + OLX map), a minor cost of the
  generic/specific split.

## Alternatives considered

- **Cheerio DOM-card scraping** (Rieltor-style). Rejected as *primary*: OLX's hashed CSS-module
  classes rotate on redeploy, making selectors brittle. Retained only as an optional last-resort
  fallback inside `nextDataThenCards`, never the main path.
- **A single monolithic OLX parser** (no generic/specific split). Rejected: the `__NEXT_DATA__`
  extraction and deep-walk are genuinely reusable for other Next.js sites; folding them into an
  OLX-only function would force a rewrite the next time one is added.
- **A headless browser** (Playwright/Puppeteer) to render OLX. Rejected: heavy, fragile, and
  needless — the data is already in the HTML as JSON; a headless engine adds no data and a large
  footprint, contradicting the lean two-container stack (Constitution principle 2).
