# ADR-0005: OLX re-enabled only behind a configured proxy (proxy-gated source)

**Status:** proposed
**Date:** 2026-07-09

> Scope: the planned "Proxy-Enabled OLX Source" feature
> ([`specifications/product/specs/001-feature/spec.md`](../../product/specs/001-feature/spec.md)).
> This ADR is the counterpart to ADR-0003's own reopening clause ("Розширення (OLX/lun/flatfy)
> впирається в **один** блокер — резидентський/ротаційний проксі"). It does not revisit
> lun.ua/flatfy.ua (still excluded as LUN-ecosystem duplicates, not for proxy reasons) or
> birdrent/josti (app-only). OLX only.

## Context

OLX.ua returns HTTP `403` (a Cloudflare bot-fight challenge) to the droplet's datacenter IP, so
a direct fetch cannot pass — the reason OLX was removed in ADR-0003. The one known fix is to route
OLX requests through a residential/rotating proxy. The plumbing for that already exists and is
unused: `HttpListingSource` reads an optional `cfg.proxyUrl` (`HTTP_PROXY_URL`) and wires it into
its axios client (`src/sources/http-listing-source.ts:59`, `parseProxy` at `:139-158`). It was
built generically for all sources, not OLX-specifically.

The risk to design around: if OLX is enabled but **no** proxy is configured, a naive
implementation would send direct datacenter-IP requests that are guaranteed to `403` — burning the
retry budget and re-training Cloudflare on our IP, for zero listings. The spec (FR-006, US-3,
SC-004) requires that OLX never runs un-proxied: it must be *inert* until a proxy exists, and the
operator must be told why (Constitution principle 9 — "свідоме звуження, не тихі поломки").

## Decision

Re-enable **OLX only**, and make it a **proxy-gated source**: OLX is included in the active source
set *only when* `HTTP_PROXY_URL` is configured. Concretely:

1. Add `'olx'` to `KNOWN_SOURCE_IDS` and `olx: 'OLX'` to `SOURCE_LABELS`
   (`src/sources/listing.interface.ts:64,67-70`), and register an `olx` `SiteSpec` in `SITE_SPECS`
   (`src/sources/site-specs.ts:200-203`). This makes `SOURCES=olx` a recognised value rather than
   an unknown id silently dropped by config (`src/config/configuration.ts:74-79`).
2. Mark the OLX `SiteSpec` as proxy-gated via a new optional, declarative flag on the `SiteSpec`
   contract: `requiresProxy?: boolean` (`src/sources/http-listing-source.ts:21-32`). OLX sets it;
   DOM.RIA/Rieltor do not. The flag is generic, not an `id === 'olx'` special-case, so any future
   proxy-blocked source reuses it.
3. Apply the gate in one place — the sources-module factory
   (`src/sources/sources.module.ts:14-25`), where sources are turned into instances and a `Logger`
   already exists. When `spec.requiresProxy && !cfg.proxyUrl`, the factory **does not instantiate**
   the `HttpListingSource` for that spec and emits a single startup-time notice naming the reason.
   Because the source never enters `LISTING_SOURCES`, `SourceRegistry` never sees it and the
   scheduler never fetches it — zero direct OLX requests, guaranteed structurally rather than by a
   runtime guard inside the fetch path.
4. Reuse the **shared** proxy config: OLX routes through the same `cfg.proxyUrl` axios `proxy`
   setting every source shares (`src/sources/http-listing-source.ts:56-65`). No OLX-specific proxy
   env var, no second proxy code path (FR-007).
5. When a proxy *is* configured but OLX still fails at runtime (proxy down, Cloudflare still
   blocking, markup drift), the existing `ListingSource` contract applies unchanged: return `[]`,
   never throw (`src/sources/listing-source.interface.ts:9-27`), so DOM.RIA/Rieltor and every other
   profile continue unaffected (Constitution principle 3; NFR-004).

Gating at the module factory (not at runtime, not in `configuration.ts`) is deliberate:
`configuration.ts` stays a pure env→data mapper (it only *knows* `olx` and holds `proxyUrl`); the
factory is the single behavioural gate and the single log site, so there is exactly one place the
"OLX is off because no proxy" decision and message live.

## Consequences

- ➕ OLX cannot ever issue an un-proxied request: absent a proxy it is not constructed at all
  (SC-004). The etiquette (retry/backoff, UA rotation, jitter, per-cycle dedup) OLX inherits from
  `HttpListingSource` is the same as every other source — no OLX-specific aggressiveness (FR-009,
  NFR-006).
- ➕ Zero new plumbing: OLX reuses `parseProxy`/`HTTP_PROXY_URL` and the generic `SiteSpec` runner.
  The only interface change is one optional boolean field (`requiresProxy`), backward-compatible
  with the two existing specs.
- ➕ Operator gets an explicit, once-at-startup notice when OLX is requested but proxy-less, instead
  of silent absence or a flood of 403s (Constitution principle 9; observability per US-3/US-4).
- ➖ **Cost & reliability.** A residential/rotating proxy is a paid, metered, third-party dependency
  that can be flaky, rate-limited, or eventually detected by Cloudflare — unlike the free official
  DOM.RIA API and the currently-unblocked Rieltor HTML. Budget and monitor it; by design a proxy
  outage degrades to "OLX contributes nothing this cycle," never a cycle-wide failure. Procuring the
  proxy is an ops task outside this feature (spec §Out-of-scope).
- ➖ **ToS / legal posture.** Fetching OLX through a proxy specifically to route around a Cloudflare
  challenge is a materially greyer area than Rieltor (no active block bypassed) or DOM.RIA (official
  key-based API). It is tolerable only for the current private, non-commercial, allowlisted group;
  any public launch or monetization is an explicit trigger for legal review before shipping (mirrors
  ADR-0003's flag and spec §Risks).
- ➖ **No PII widening.** OLX pages can expose seller phone numbers/names; the adapter must persist
  only the same non-PII fields as the other sources (id/title/price/area/rooms/district/url/image/
  isBusiness) — never contact data (FR-014, NFR-008). This is a standing constraint, not a one-off.

## Alternatives considered

- **Gate at runtime inside the OLX fetch** (construct the source, but return `[]` when
  `!cfg.proxyUrl`). Rejected: the source would still exist in the registry, the "why" would be
  buried in per-cycle logs, and it invites a future edit that accidentally issues a request before
  the guard. Not-instantiating is structurally safer.
- **Gate in `configuration.ts`** (drop `olx` from `enabled` when no proxy). Workable, but it forces
  `configuration.ts` — today a pure, side-effect-free env parser — to emit a Nest `Logger` notice,
  and splits the "OLX known" vs "OLX active" logic across two files. The factory already logs
  `sources=[...]` (`sources.module.ts:19`), so it is the natural single gate + notice site.
- **A dedicated `OLX_PROXY_URL`.** Rejected: duplicates the existing shared `HTTP_PROXY_URL` for no
  benefit and contradicts FR-007's "one shared proxy for all sources."
- **Re-enable OLX un-gated and let it 403.** Rejected outright: guaranteed wasted requests, retry
  budget burn, and IP reputation damage, for zero listings — the exact failure mode this ADR exists
  to prevent.
