# Flat Hunter Bot — Review / Gap Analysis (against `002-existing/spec.md`)

**Base commit:** `9c61511` ("chore: remove OLX entirely (#23)").
**Scope:** `src/**`, `package.json`, `docker-compose.yml`, `Dockerfile`, `.github/workflows/deploy.yml`,
`.env.example`, `README.md`, root `CLAUDE.md`. Builds on `specifications/product/specs/002-existing/spec.md`
(read first) — this document does not repeat that spec's factual descriptions except where needed to
frame a finding. All citations are `path:line` against the current tree; uncertain claims are marked
`[NEEDS VERIFICATION]`.

---

## Verdict

**Mostly "written as intended," but not yet production-hardened.** The resilience *shape* the brief asked
for (per-source / per-profile / per-notification / per-cycle isolation, Redis-only state, seen-as-a-hash
for price-change detection, fail-closed allowlist) is implemented faithfully and is well unit-tested. The
core scheduler/persistence layer is the strongest part of the codebase.

However: there is one confirmed **correctness bug that silently produces wrong price data** for
Rieltor `sale` listings (Finding C-1), a **missing Telegraf error boundary** that can crash the whole
process on a single user's bad interaction — directly contradicting the project's own stated resilience
requirement (Finding H-1), and a **coverage gap in DOM.RIA's detail-fetch budget** that can permanently
drop new listings for popular searches without any error or log to indicate it happened (Finding H-2).
None of these are visible from the outside under light load / today's small allowlisted group, which is
exactly why they're worth fixing before the group or polling volume grows. Documentation (`CLAUDE.md`,
`README.md` "Known limitations", `package.json`, `Dockerfile`) has also drifted from the shipped
one-filter-per-user, multi-site design and should be reconciled, especially since `CLAUDE.md` is marked as
override-authoritative for future AI-assisted work on this repo.

---

## 1. Implemented / Missing / Incorrect

| Area (per `CLAUDE.md` brief + best practice) | Status | Notes |
|---|---|---|
| Redis-only persistence, no SQL | ✅ Implemented | `src/persistence/*`; matches brief exactly. |
| Seen-hash (`listingId → lastPrice`), not a plain set | ✅ Implemented | `src/persistence/seen-listings.repository.ts`; brief's own called-out nuance, done right. |
| Mark-seen only after successful send | ✅ Implemented | `src/scheduler/scheduler.service.ts:183-199`. |
| Per-source / per-profile / per-notification / per-cycle isolation | ✅ Implemented | `scheduler.service.ts` throughout; well tested (`scheduler.service.spec.ts`). |
| Fail-closed allowlist, polite rejection | ✅ Implemented | `src/telegram/allowlist.middleware.ts`; tested. |
| `/forgetme` | ✅ Implemented | `telegram.update.ts:64-78,154-167`. |
| Jittered polling, retry+backoff, rotating UA, request dedup | ✅ Implemented | `src/sources/http-listing-source.ts`, `retry.util.ts`; tested. |
| Scraper behind an interface (swap direct-fetch vs. proxy) | ✅ Implemented | `ListingSource`/`SiteSpec` abstraction; proxy is a config knob, not a rewrite. |
| **Multiple profiles per user** ("apartment for me" + "garage as investment") | ❌ **Missing (deliberate pivot, undocumented in CLAUDE.md)** | `SearchProfilesService.upsertForUser` collapses to exactly one profile per user (`search-profiles.service.ts:66-88`). This is a real, intentional product decision (README calls it "One filter, all sites") but `CLAUDE.md` still specifies multi-profile support as a requirement — the brief was never updated to reflect the pivot. |
| District filter (wizard step) | ❌ **Missing** | `SearchCriteria.district` exists and is consumed by `matchesCriteria` (`search-profile.model.ts:52-56`), but `/newsearch` never collects it (confirmed dead by grep — no wizard stage sets `criteria.district`). The branch is unreachable in practice. |
| Owner-only vs. include-realtors toggle (wizard step) | ❌ **Missing** | Hardcoded `ownerOnly: false` on every save (`newsearch.wizard.ts:197`). `parseOwnerChoice`/`OWNER_ONLY_LABEL`/`INCLUDE_ALL_LABEL` exist and are unit-tested but never wired into the wizard (`src/telegram/parsing.util.ts:56-82`, confirmed unused by grep). Users can never actually get owner-only filtering, even though Rieltor supports it server-side (`site-specs.ts:25`). |
| City coverage | ⚠️ **Incorrect vs. brief's spirit, but intentional** | Wizard hard-restricts to `/київ/i` (`newsearch.wizard.ts:119-124`); DOM.RIA's geo map only has Kyiv (`site-specs.ts:45-49`). Documented as a known limitation, not silently broken — fine as a scoping decision, but `CLAUDE.md` doesn't mention this scope-down either. |
| OLX as a source | ❌ Removed | Confirmed gone from `KNOWN_SOURCE_IDS`/`SITE_SPECS`. `CLAUDE.md`'s entire "Goal" section still describes an OLX-only bot — see Finding L-4. |
| Rieltor price currency handling | ❌ **Incorrect** | See Finding C-1 below — always labeled UAH regardless of actual currency. |
| DOM.RIA price currency handling | ✅ Implemented, correctly | `site-specs.ts:72-84`; careful UAH normalization with an explicit no-mislabel fallback. Contrast with Rieltor above. |
| Global Telegraf error handler (`bot.catch`) | ❌ **Missing** | See Finding H-1. |
| Price history / trend store | ❌ Explicit non-goal, honored | Only current-vs-last-seen; matches brief. |
| Access control via env allowlist (v1) | ✅ Implemented | `ALLOWED_USER_IDS` CSV, fail-closed. Redis-Set upgrade path noted in README but not built — acceptable, matches brief's "fine for now" framing. |

---

## 2. Critical

### C-1 — Rieltor sale-price is silently mislabeled as UAH; no currency detection at all
**Where:** `src/sources/parsing.util.ts:32-34` (doc comment asserting "always UAH for the UA market"),
`src/sources/parsing.util.ts:84-85` (`price: toInt(card.attr('data-label') || ...)`, `currency: 'грн'`
hardcoded at `parsing.util.ts:85`); URL builder `src/sources/site-specs.ts:18-28` has no currency handling
either.

**Why it matters:** Ukrainian real-estate **sale** listings (as opposed to rent) are overwhelmingly quoted
in **USD** on public sites, not UAH. `operation: 'sale'` is one of only two supported operations
(`SearchCriteria.operation`, `listing.interface.ts:19`), and Rieltor is one of only two sources. For a
Rieltor sale listing priced e.g. "$95 000", `toInt()` strips all non-digits and would extract `95000` (or
whatever digits happen to be present) and label it `'грн'` — off by roughly two orders of magnitude from
the true UAH-equivalent price. This corrupts:
- the price shown to the user in the notification (`telegram.service.ts:104-109`),
- `matchesCriteria`'s price-range filter (`search-profile.model.ts:39-40`), which compares this bogus
  number against a UAH `priceMin`/`priceMax` the user entered assuming grivnya,
- price-change detection (a currency mismatch could look like a legitimate multi-order-of-magnitude "price
  change" and spam a false alert, or mask a real price change if the digits coincidentally match).

Contrast this with **DOM.RIA**, which handles the identical problem correctly and deliberately
(`site-specs.ts:72-84`, `domriaUahPrice`) — the asymmetry between the two sources is itself a sign this
was simply missed for Rieltor, not a considered decision.

**Test coverage confirms the gap is real and untested:** `src/sources/parsing.util.spec.ts:37-96` (Rieltor
parser tests) only ever uses UAH-labeled fixtures (`"20 000 грн"`, `"12 500 грн"`); there is no fixture for
a `$`/USD-denominated sale card, and no assertion anywhere that a non-UAH price is detected, converted, or
rejected.

**Fix:** Detect currency from the card markup (rieltor.ua typically exposes `$`/`€` symbols or a currency
class near the price) and either convert to UAH with a fetched/approximated rate or fall back to `price:
null` ("Ціна договірна") the way DOM.RIA does for an unconvertible foreign price (`site-specs.ts:83`) —
never fabricate a UAH number from foreign-currency digits. Add fixtures mirroring `site-specs.spec.ts`'s
DOM.RIA currency tests (`site-specs.spec.ts:115-144`).

**Severity: Critical** (silently wrong data shown to and matched against for the user, for a fully
supported operation/source combination; not a crash, but it undermines the entire premise of a
budget-based filter bot).

---

## 3. High

### H-1 — No Telegraf `bot.catch()` error boundary; combined with the global `unhandledRejection` handler, one bad update can kill the whole process
**Where:** `src/telegram/telegram.module.ts:15-27` (`TelegrafModule.forRootAsync`, only
`middlewares: [allowlist, session()]` — no `catch`/error handler configured anywhere in the module or
`TelegramUpdate`/`NewSearchWizard`); `src/main.ts:20-34` (`installProcessGuards` — any
`unhandledRejection` anywhere in the process, not just Telegram-related, logs and calls `process.exit(1)`).

**Why it matters:** Telegraf's own documentation states that without an installed `bot.catch()`, an error
thrown inside any middleware/handler (a command, an `@Action`, a wizard step) propagates instead of being
contained per-update. Nothing in this codebase registers one — confirmed by grep (`bot\.catch` matches
nothing in `src/`). Handlers here are not uniformly defensive either: e.g. `onMySearches`
(`telegram.update.ts:34-52`) awaits `ctx.reply()` in a loop with no try/catch — if the user has since
blocked the bot or a message fails to send, that throw has nowhere to land except Telegraf's default
handler. If that in turn surfaces as an unhandled promise rejection, `main.ts`'s handler terminates the
**entire process** — not just that one user's update — for every user, until Docker's
`restart: unless-stopped` brings it back. `[NEEDS VERIFICATION: exact propagation path through
telegraf's polling loop — could not run the app or inspect `node_modules` (not installed) to confirm
whether nestjs-telegraf installs its own default `bot.catch` internally; the finding is that this
repo's own code does not, which contradicts Telegraf's documented best practice and CLAUDE.md's explicit
requirement below.]`

This is a direct hit against `CLAUDE.md`'s own resilience requirement: *"One user's Telegram API error
(blocked bot, rate limit) must not crash the polling loop for everyone else."* The scheduler side of that
requirement is implemented well (§5.1 of the spec); the **interactive command side is not** covered by the
same guarantee.

**Fix:** Add `bot.catch((err, ctx) => { logger.error(...); })` in `TelegramModule` (or via
`TelegrafModule.forRootAsync`'s options if supported) so a single handler's throw is logged and swallowed,
never propagating to `main.ts`'s global guard. Wrap `onMySearches`'s per-profile reply loop
(`telegram.update.ts:46-51`) in a try/catch per message so one failed `ctx.reply` doesn't abort the rest
of the list either.

**Severity: High** (real gap against a project-stated requirement, bounded blast radius by the restart
policy, but affects *every* user simultaneously, not just the one who triggered it).

---

### H-2 — DOM.RIA's per-cycle detail-fetch budget can permanently drop new listings for high-volume searches
**Where:** `src/sources/site-specs.ts:113-119` (`DOMRIA_SEARCH_WINDOW = 100`, `DomriaCache.known`/`recent`),
`site-specs.ts:166-176` (only the newest `ctx.cfg.domria.maxDetails` — default **10**,
`configuration.ts:105` — not-yet-known ids get a detail call per cycle), `site-specs.ts:178-184`
(`known` is pruned to whatever remains in the current top-100 `window`).

**Why it matters:** An id that is in `window` but not yet in `known` stays eligible for a detail fetch on a
future cycle — **unless** it ages out of the top-100 newest-ids window before its turn comes (i.e. more
than 100 newer listings appear before it's ever detail-fetched). For a popular search bucket (broad city +
price range with no `DOMRIA_API_KEY` quota pressure to force `maxDetails` down further), a burst of new
listings — e.g. more than `maxDetails` × (window-lifetime-in-cycles) new listings in the same
city/operation/price bucket — will cause some of them to fall out of `window` having never been
detail-fetched, so they never enter `cache.recent`, never reach `matchesCriteria`, and **never generate a
notification** — with no error, warning, or any observable signal that it happened. This is the kind of
silent coverage loss that's hardest to notice precisely because the bot otherwise "looks like it's
working" (it keeps notifying about *other* listings in the same search).

**Compounding factor (Finding M-4 below):** the search request itself (`site-specs.ts:151-161`) doesn't
filter by area or rooms (DOM.RIA client-side-only fields), so the scarce `maxDetails` budget is spent on
the newest ids regardless of whether they'll later be discarded by `matchesCriteria`'s area/rooms check
(`search-profile.model.ts:42-50`) — narrowing the effective "useful" budget for area/room-narrow profiles
even further, making this backlog-eviction scenario more likely to actually bite in practice, not just in
theory.

**Test coverage:** `site-specs.spec.ts:146-174` ("fetches details only for NEW ids on a second cycle")
exercises exactly 2 cycles with 1-3 ids total — nowhere near the volume needed to exhibit or guard against
window eviction. There's no test with `newIds.length > maxDetails` persisting across 3+ cycles, and no
test asserting an id that ages out of `window` is dropped (which would at least document the tradeoff even
if not fixing it).

**Fix (pick one, in order of preference):** (a) increase `DOMRIA_SEARCH_WINDOW` relative to expected
listing velocity for the busiest buckets, or make it configurable; (b) track a persistent
(Redis-backed, not in-memory) "oldest unprocessed id" watermark per cache key so backlog survives restarts
and cycles, rather than only tracking a bounded window; (c) at minimum, log a warning when ids age out of
`window` while still unprocessed, so the condition is at least observable in production instead of purely
silent.

**Severity: High** (silent notification-coverage loss — directly undermines the product's core promise —
gated behind "if a search is popular enough," so more likely to surface as the user base or polling
frequency grows).

---

### H-3 — `esc()` doesn't escape attribute-context characters; used inside an `href="..."` attribute — and a resulting failure retries forever, never resolving
**Where:** `src/telegram/telegram.copy.ts:30-35` (`esc()` — escapes only `& < >`),
`src/telegram/telegram.service.ts:99` (`` `<a href="${esc(listing.url)}">...` `` — an **attribute** context,
which additionally requires `"` to be safe), fed by scraped, third-party `href` values
(`src/sources/parsing.util.ts:58-61`) and DOM.RIA's `beautiful_url`
(`src/sources/site-specs.ts:99-101`).

**Why it matters:** Telegram's HTML parse mode requires quotes inside attribute values to be safe/escaped;
`esc()` only handles the three characters that matter in *text* content, not attribute content. A scraped
URL containing a literal `"` (malformed upstream markup, an unusual query string, etc.) would either break
the `<a href="...">` tag or make Telegram's parser reject the whole message with a "can't parse entities"
error. That in turn interacts badly with the scheduler's delivery contract: `deliver()`
(`src/scheduler/scheduler.service.ts:183-199`) only calls `seen.markSeen(...)` **after** a successful
send; on a parse-mode failure the catch block logs a warning and intentionally leaves the listing unseen
"to retry next cycle" (`scheduler.service.ts:192-197`). But the URL that caused the failure doesn't change
between cycles, so the retry fails identically **every cycle, forever** — the listing becomes permanently
un-notifiable for that profile with no operator-facing signal beyond a recurring warning log line, and no
end-user-facing signal at all.

**Fix:** Escape `"` (and ideally single quotes, defensively) wherever `esc()`'s output lands inside an
HTML attribute, or add a dedicated `escAttr()` helper for that call site. Consider also giving `deliver()`
a retry cap or a way to permanently skip/flag a listing that fails to send N times in a row (rather than
"retry forever"), so a data-shaped failure like this can't silently starve a profile of one specific
listing indefinitely.

**Severity: High** (low likelihood given how clean scraped URLs usually are in practice, but the failure
mode is a genuine, permanent, silent notification loss — same class of problem as H-2 — and the fix is
small).

---

## 4. Medium

### M-1 — Scheduler fetches unique (source, requestKey) pairs sequentially, not concurrently
**Where:** `src/scheduler/scheduler.service.ts:108-113` — nested `for` loops with `await` inside, one
`fetchOne` call at a time, rather than `Promise.all`-ing the set of unique fetches for the cycle.

**Why it matters:** Cycle wall-clock time grows roughly linearly with the number of *distinct* active
search buckets (unique per-source requestKey combos across all users) × per-fetch latency (which, under
retry/backoff, can be tens of seconds in the worst case — `retries: maxRetries` (default 3),
`maxDelayMs: 8000`, `http-listing-source.ts:113,128`). As the allowlisted group grows and users pick more
varied filters, this can push a cycle close to or past `POLL_INTERVAL_MS` (5-10 min default), interacting
with the "skip this beat if still running" overlap guard (`scheduler.service.ts:76-80`) and effectively
halving the observed notification cadence under load, silently.

**Fix:** Collect the unique `(sourceId, requestKey)` pairs first, then `Promise.all` the fetches (each
`fetchOne` already returns `[]` on failure, so this is a safe, mechanical change) instead of the current
nested sequential loop.

**Severity: Medium** (no incorrect behavior today at the current tiny group size; a real scalability
ceiling worth fixing before it's needed rather than after it's noticed).

---

### M-2 — Cross-source "freshest 5" priming assumption has no timestamp to back it, and source order is fixed
**Where:** `src/scheduler/scheduler.service.ts:121` (`sourceIds.flatMap(...)` — concatenates each source's
listings in `sourceIds` order, not interleaved by any real recency signal), `scheduler.service.ts:138,140`
(`matched.slice(0, INITIAL_SHOW)` / comment "Sources return newest-first, so the head of `matched` is the
freshest"). Neither `RawListing` nor `Listing` (`src/sources/listing.interface.ts:26-49`) carries any
publish/scraped timestamp field.

**Why it matters:** Each source's own list is (probably) newest-first *within that source*, but merging
two sources by simple concatenation (`domria` always before `rieltor`, per `KNOWN_SOURCE_IDS` /
`sources.ids` enumeration order) is not the same as a true cross-source recency merge. On a first poll for
a profile with both sources enabled and enough DOM.RIA matches, all 5 "priming" notifications could be
DOM.RIA listings while a genuinely fresher Rieltor listing gets silently seeded (never shown) instead —
contradicting the inline comment's stronger claim.

**Fix:** Either add a normalized timestamp to `RawListing` (if the sites expose one) and sort the merged
list by it before slicing, or soften the comment/behavior to be explicit that priming is
"freshest-per-source, source-priority-ordered" rather than implying a true global recency guarantee.

**Severity: Medium** (only affects the one-time priming experience for multi-source profiles, not
steady-state correctness).

---

### M-3 — Wizard is inconsistent about validating free-text input at the price/area steps
**Where:** `src/telegram/newsearch.wizard.ts:144-186` (`handlePrice`, `handlePriceManual`, `handleArea`,
`handleAreaManual` — always call `applyPrice`/`applyArea` on any text that isn't the `OTHER`/`"інше"`
button, with no re-prompt path), vs. `handleOperation`/`handleCity`/`handleRooms`
(`newsearch.wizard.ts:104-142`), which all explicitly re-prompt on unrecognized text.

**Why it matters:** `parseRange()` (`src/telegram/parsing.util.ts:35-54`) treats any text with no
extractable digits and no recognized skip-word as `{}` — "no constraint." Combined with the wizard's lack
of a re-prompt at these two steps, a stray non-numeric reply (typo, accidental send, emoji) silently saves
an unbounded ("будь-яка") price or area filter with **zero feedback** that the input wasn't understood —
inconsistent with the rest of the wizard's UX, which always confirms or rejects.

**Fix:** At `handlePrice`/`handleArea`(Manual), only accept known button texts / a successfully-parsed
range / an explicit skip word; re-prompt (like the other stages) on anything else instead of silently
defaulting to "no constraint."

**Severity: Medium** (UX/robustness, not a crash; easy to reproduce and easy to fix).

---

### M-4 — DOM.RIA's scarce detail-fetch budget is spent before the area/rooms client-side filter runs
**Where:** `src/sources/site-specs.ts:151-176` (search request has no area/rooms params — only
category/operation/geo/lang/price — so `maxDetails` newest ids are chosen without regard to whether
they'll later fail `matchesCriteria`'s area/rooms check), `src/search-profiles/search-profile.model.ts:42-50`.

**Why it matters:** For a profile with a narrow area range (e.g. 30–45 m²) in a busy price bracket, most of
the ≤10 detail calls per cycle can be "wasted" on listings that get discarded client-side, directly
feeding into Finding H-2's backlog-eviction risk for exactly the profiles that most need the budget spent
efficiently (narrow filters, by definition, need to see more of the raw feed to find their few matches).

**Fix:** No API-side fix exists (DOM.RIA's public API doesn't take area/rooms params, per the code
comments), so this is really a documentation/tuning note: operators with narrow-area users active should
raise `DOMRIA_MAX_DETAILS` accordingly, and this tradeoff is worth calling out explicitly in the README's
"Rate limits" section (currently silent on this interaction).

**Severity: Medium** (compounds H-2; no independent fix available beyond operational tuning + awareness).

---

### M-5 — `REDIS_KEY_PREFIX` default (`olx`) is a live foot-gun for a future cleanup
**Where:** `src/config/configuration.ts:88`, `.env.example:26`, `docker-compose.yml:26`.

**Why it matters:** `olx` is confirmed dead as a source id (`src/sources/listing.interface.ts:64`,
`src/sources/site-specs.ts:191-194` no longer list it) — it survives only as this default's literal value.
It works fine today, but it is exactly the kind of "this looks like leftover cruft, let me rename it"
default a future contributor (human or AI, following `CLAUDE.md`'s override instruction) might "clean up"
without realizing that changing it orphans **every existing profile and seen-hash** in Redis (new prefix ⇒
empty namespace ⇒ the scheduler sees zero profiles, and every previously-notified listing looks brand new
again once profiles are recreated under the new prefix).

**Fix:** Either rename it now (in a controlled migration, while the deployed dataset is presumably still
small) or leave an explicit, loud comment at the default site itself (not just in a spec/test comment)
warning that changing it requires a data migration, not just an env var edit.

**Severity: Medium** (operational risk, not a current bug; cheap to mitigate with either a migration or a
louder warning).

---

## 5. Low

### L-1 — Dead code: owner-only/district wizard helpers, `SourceRegistry.fetchAll`, `SeenListingsRepository.isEmpty`
**Where:**
- `src/telegram/parsing.util.ts:56-89` (`parseOwnerChoice`, `parseOptionalText`, `OWNER_ONLY_LABEL`,
  `INCLUDE_ALL_LABEL`) — exported and unit-tested (`parsing.util.spec.ts`) but never called outside their
  own spec (confirmed by repo-wide grep). Directly tied to the "Missing" wizard features noted in §1.
- `src/sources/source-registry.service.ts:59-71` (`fetchAll`) — only called from
  `source-registry.service.spec.ts`; the scheduler exclusively uses `fetchOne`
  (`scheduler.service.ts:111`).
- `src/persistence/seen-listings.repository.ts:55-58` (`isEmpty`) — only called from
  `seen-listings.repository.spec.ts`.

**Why it matters:** None of this is harmful by itself, but it inflates the "96% coverage" figure
(README.md:327) with code no production path ever exercises, and — for the wizard helpers specifically —
signals an unfinished feature (owner-only/district) rather than genuinely dead code, which is worth
distinguishing from `fetchAll`/`isEmpty` (which look like leftover API surface from an earlier design and
could simply be deleted).

**Fix:** Either wire the owner-only/district helpers into the wizard (closing the §1 "Missing" gaps) or
remove them together with their tests; delete `fetchAll`/`isEmpty` if genuinely unused, or keep them but
note in a comment that they're intentionally-public API for future callers.

**Severity: Low.**

---

### L-2 — Minor redundant condition in `matchesCriteria`
**Where:** `src/search-profiles/search-profile.model.ts:48` —
`if (c.rooms != null && listing.rooms != null && listing.rooms !== undefined)`. `!= null` already covers
`undefined`, so `listing.rooms !== undefined` is dead.

**Severity: Low** (cosmetic; no behavioral impact).

---

### L-3 — Profile id entropy is 32 bits
**Where:** `src/search-profiles/search-profiles.service.ts:23-25` (`randomBytes(4).toString('hex')`).

**Why it matters:** Every mutating path (`setPaused`, `delete`) checks `profile.userId === userId` before
acting (`search-profiles.service.ts:107-123`), and both the "not found" and "not yours" cases return the
same generic message (`telegram.update.ts:98-101,126-130`), so guessing a valid-but-foreign id yields no
usable oracle and no exploitable action today. Flagging purely for completeness / in case ids are ever
exposed for a different purpose (e.g. a future deep-link).

**Severity: Low — no action needed under current usage.**

---

### L-4 — Documentation drift: `CLAUDE.md`, `README.md`, `package.json`, `Dockerfile` all reference a stale/removed design
**Where:**
- Root `CLAUDE.md` — the entire "Goal" section describes an OLX-only bot ("Build a Telegram bot that
  monitors OLX housing listings…"); "Multiple profiles per user" is specified as a requirement, contradicted
  by the shipped one-filter-per-user design (`search-profiles.service.ts:60-88`); "Filters" lists District
  and an owner-only Toggle as wizard-collected fields, neither of which the wizard collects (§1). Since
  `CLAUDE.md` is explicitly marked "IMPORTANT: These instructions OVERRIDE any default behavior," a future
  AI-assisted change following this brief literally could regress the shipped multi-site,
  one-filter-per-user design or attempt to "restore" OLX support that was deliberately removed.
- `README.md:335-337` ("Known limitations / next steps" → "Only DOM.RIA is wired to the wizard") is stale
  and self-contradicting: it directly conflicts with the same document's own "One filter, all sites"
  feature bullet (`README.md:18-20`) and with the wizard's own intro copy, which explicitly says "Шукаю на
  всіх сайтах (DOM.RIA + Rieltor)" (`newsearch.wizard.ts:60`).
- `package.json:4` — description still reads "Telegram bot that monitors OLX housing listings…".
- `Dockerfile:30` — comment still reads "the bot only makes outbound calls (Telegram long polling + OLX)".

**Fix:** Update `CLAUDE.md` to reflect the current, deliberate product shape (multi-site,
one-filter-per-user, DOM.RIA + Rieltor, Kyiv-only) so it stops being a misleading source of truth for
future work; delete/rewrite the stale "Only DOM.RIA is wired to the wizard" README bullet; refresh the two
one-line OLX mentions in `package.json`/`Dockerfile`.

**Severity: Low-to-Medium** (no runtime impact, but real risk of misdirecting future changes given
`CLAUDE.md`'s stated override authority).

---

## 6. Test coverage — what's solid vs. thin

**Solid, well-targeted coverage:**
- Scheduler diff/priming/dedup/delivery-contract logic (`scheduler.service.spec.ts`) — covers priming cap,
  seed-vs-notify split, new/changed/unchanged diffing, fetch dedup by requestKey, multi-source merge,
  failed-send-doesn't-mark-seen, and the tick/overlap-guard lifecycle. This is the app's riskiest logic and
  it's the best-tested part of the codebase.
- DOM.RIA site spec (`site-specs.spec.ts`) — geo resolution, unmapped-city skip, detail-fetch capping,
  currency normalization (including the "$500 with no UAH figure → null" fallback), and the 2-cycle
  opt-2 cache behavior.
- `matchesCriteria` (`search-profile.model.spec.ts`) — every filter dimension has a positive and negative
  case, including the null-price and null-area edge cases called out in the spec.
- Redis repositories against `ioredis-mock` (`profiles.repository.spec.ts`,
  `seen-listings.repository.spec.ts`) — real round-trips, not just mocked calls, including the `"null"`
  price-encoding edge case.
- Wizard state machine (`newsearch.wizard.spec.ts`) — full happy path, 4+ rooms, "Будь-яка", manual entry,
  non-Kyiv rejection, cancel (button + command), unknown-stage reset.
- Allowlist middleware, `TelegramUpdate` commands/actions, `TelegramService` notification formatting — all
  have dedicated, fairly complete spec files.
- CI coverage gate (`jest.config.js:18-20`, thresholds 80/80/80/70) matches README's claimed
  "~96% statements/98% lines" and is enforced on every push/PR (`.github/workflows/deploy.yml:37-38`) —
  good practice, actually wired up rather than just aspirational.

**Thin or missing, tied to findings above:**
- No Rieltor fixture with a non-UAH (`$`/`€`) price — the exact scenario in Finding C-1 is untested, which
  is presumably why it shipped unnoticed.
- No scheduler/site-spec test drives the DOM.RIA cache past 2 cycles or past `maxDetails` new ids per
  cycle for 3+ cycles — Finding H-2's window-eviction scenario has no regression guard.
- No test asserts on the multi-source priming order interaction described in Finding M-2 (existing
  multi-source test only checks that both sources' listings eventually notify, not the 5-item cap's
  interaction with source order).
- No test for the price/area "unrecognized free text silently becomes unbounded" behavior in Finding M-3.
- `src/main.ts` is explicitly excluded from coverage collection (`jest.config.js:13`) — reasonable for
  process-lifecycle bootstrap code, but it means the 401/404 `unhandledRejection` translation and the
  interaction described in Finding H-1 have zero automated coverage, even at the unit level.
- No integration/smoke-level test exists for Telegraf error propagation (`bot.catch` absence) — understandably
  out of scope for unit tests, but worth at least a documented manual-test checklist item if one doesn't
  exist elsewhere.

---

## 7. Security / robustness — additional notes

- **Allowlist:** fail-closed, tested, matches the brief exactly. No issues found.
- **Ownership checks:** every mutating profile action (`setPaused`, `delete`, action-callback handlers)
  verifies `profile.userId === ctx.from.id` before acting — consistently applied, no IDOR found.
- **Secrets handling in CI/CD:** genuinely solid — SSH-shell env vars over an encrypted channel, never
  written to a file, explicit `rm -f .env` on the droplet, secrets masked by GitHub Actions
  (`.github/workflows/deploy.yml:95-105`). The README's own caveat about `docker inspect` still being able
  to reveal env vars to a root-level compromise is an honest, appropriate disclosure rather than a gap.
- **Dependency versions:** `package.json` pins fairly recent majors (`@nestjs/*` ^10.4.x, `telegraf` ^4.16,
  `ioredis` ^5.4, `axios` ^1.7, `cheerio` ^1.0) with caret ranges — normal practice; no obviously stale or
  end-of-life major versions. `[NEEDS VERIFICATION]` — an actual `npm audit`/Dependabot pass wasn't run as
  part of this review; recommend adding one to CI if not already covered by a separate workflow (none
  found under `.github/workflows/` besides `deploy.yml`).
- **HTML-attribute escaping gap:** see Finding H-3 — the one genuine (if low-likelihood) injection-adjacent
  issue found, and it's really an input-validation/escaping-context bug more than an exploitable
  vulnerability given Telegram's restrictive HTML subset.

---

## 8. Summary of recommended fix order

1. **C-1** — Rieltor currency detection (fix or null-out non-UAH sale prices). Highest-value, most concrete
   correctness fix.
2. **H-1** — Add `bot.catch()`; wrap `onMySearches`'s reply loop. Small change, closes a real resilience gap
   against a project-stated requirement.
3. **H-3** — Escape `"` in the `href` attribute context (or add `escAttr()`). Trivial fix, removes a
   permanent-stuck-notification failure mode.
4. **H-2 / M-4** — DOM.RIA backlog: at minimum add a warning log when ids age out of the window unprocessed;
   consider a persistent watermark if/when this is observed in production.
5. **M-1** — Parallelize the scheduler's unique-fetch loop (`Promise.all`) — cheap, prevents a future
   scalability cliff.
6. **M-3** — Re-prompt on unrecognized price/area input instead of silently defaulting to "no constraint."
7. **M-5 / L-4** — Reconcile `CLAUDE.md`/README/package.json/Dockerfile with the shipped design before they
   mislead a future change; add a loud warning (or migrate) around `REDIS_KEY_PREFIX`'s `olx` default.
8. **L-1 / L-2** — Housekeeping: either wire up or delete the dead owner-only/district/`fetchAll`/`isEmpty`
   code; drop the redundant `!== undefined` check.
