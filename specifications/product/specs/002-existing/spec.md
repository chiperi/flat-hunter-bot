# Flat Hunter Bot — Reverse-Engineered Specification (current reality)

**Status:** Reverse-engineered from code as of commit `9c61511` ("chore: remove OLX entirely (#23)").
This document describes what the system **does today**, grounded in `path:line` citations. It is
not a design proposal; residual ambiguities are called out inline.

---

## 1. Overview & purpose

Flat Hunter Bot is a Telegram bot that monitors Ukrainian housing listings (rent or sale) against
**one saved filter per user**, and sends a Telegram notification when a new matching listing
appears or when the price of an already-seen listing changes
(`src/scheduler/scheduler.service.ts:132-176`, `src/search-profiles/search-profiles.service.ts:66-88`).

- **Tech stack:** NestJS 10 + TypeScript, `nestjs-telegraf`/`telegraf` for the Telegram integration
  in **long-polling** mode, `ioredis` for all persistence, `axios` + `cheerio` for HTTP
  fetch/HTML parsing (`package.json:22-33`).
- **Persistence:** Redis only — no PostgreSQL/SQL. `README.md:64-65` states this is deliberate
  ("flat" data: dedup + filter profiles).
- **No inbound network exposure.** `src/main.ts:43-45` boots a Nest **application context**
  (`NestFactory.createApplicationContext`), not an HTTP server — "no HTTP server ... the bot only
  makes outbound calls". `Dockerfile:29-31` confirms no `EXPOSE`, and `docker-compose.yml:22-44`
  publishes no ports on the `app` service.
- **Deployment:** an isolated Docker Compose stack (`app` + `redis`, bridge network
  `flat-hunter-net`, named volume `flat-hunter-redis-data`) deployed via GitHub Actions over SSH
  to a DigitalOcean droplet, target path `/opt/flat-hunter-bot` (`.github/workflows/deploy.yml:53-57,71-128`).
  The pipeline `rsync`s the repo (excluding `.git`, `.github`, `node_modules`, `dist`, `.env`,
  `docker-compose.override.yml`) then runs `docker compose up -d --build --remove-orphans` on the
  droplet, secrets passed as SSH-shell env vars, never written to a file
  (`.github/workflows/deploy.yml:71-127`). A post-deploy step fails the run if any service is
  `restarting`/`exited` (`.github/workflows/deploy.yml:130-148`).
- Bootstrap fails fast on a missing/malformed `TELEGRAM_BOT_TOKEN`
  (`src/config/configuration.ts:60-72`) and turns a bad-token Telegram rejection (`401`/`404`)
  into an actionable log line before exiting (`src/main.ts:20-34`).

---

## Success Criteria (measurable)

The observable guarantees the shipped system meets (traced to [`../../../architecture/nfr.md`](../../../architecture/nfr.md)):

- SC-001: a new matching listing reaches the user within **one poll cycle**
  (`POLL_INTERVAL_MS ± POLL_JITTER_MS`, default 5–10 min). *(NFR-001; scheduler diff→notify spec)*
- SC-002: **0** duplicate notifications across a process restart (seen-state in Redis, not memory).
  *(NFR-002; persistence round-trip spec)*
- SC-003: **0** silently-lost notifications — a listing is marked seen **only after** a confirmed
  send; a send failure is retried next cycle. *(NFR-003; `deliver()` spec)*
- SC-004: every notified/filtered price is in **UAH** (foreign prices converted at source rate);
  listings with no price are excluded. *(matching + site-specs currency specs)*
- SC-005: one source/profile/user/notification error never stops the cycle for others.
  *(NFR-004; per-source `[]`, per-profile/per-notify try/catch, `bot.catch`)*
- SC-006: test coverage stays **≥ 80/80/80/70** (stmt/branch/func/line), enforced on every push/PR.
  *(NFR-009; jest thresholds + CI)*

---

## 2. Module map

```
src/
├── config/            typed env parsing (single source of truth for defaults)
├── telegram/           bot commands, /newsearch wizard, allowlist, outbound formatting
├── sources/            ListingSource abstraction, site specs, registry/aggregator
├── search-profiles/    profile model + CRUD/lifecycle service (one filter per user)
├── persistence/        Redis client + repository-style access
└── scheduler/          the jittered polling loop (dedup → diff → notify)
```
Wiring: `src/app.module.ts:10-24` imports `PersistenceModule` (`@Global`), `SourcesModule`,
`SearchProfilesModule`, `TelegramModule`, `SchedulerModule`.

### 2.1 `config/`
`src/config/configuration.ts` exposes a single typed `AppConfig` (`telegram`, `redis`, `polling`,
`sources`) read via `ConfigService<AppConfig, true>` everywhere (`src/config/configuration.ts:1-109`).
- Validates `TELEGRAM_BOT_TOKEN` presence and shape (`^\d{6,}:[A-Za-z0-9_-]{20,}$`)
  (`src/config/configuration.ts:60-72`).
- `SOURCES` is parsed as CSV, lower-cased, and filtered against `KNOWN_SOURCE_IDS`; unknown ids are
  silently dropped; an empty/unset value defaults to **all known sources**
  (`src/config/configuration.ts:74-79`).
- Redis default `REDIS_KEY_PREFIX` is `'olx'` — confirmed as a **legacy namespace, not a source
  indicator** by both the config default (`src/config/configuration.ts:88`) and a test comment
  ("legacy Redis namespace (not a source)", `src/config/configuration.spec.ts:30`).
- `DOMRIA_MAX_DETAILS` (default 10) caps per-cycle DOM.RIA detail calls
  (`src/config/configuration.ts:99-106`).

### 2.2 `telegram/`
- `telegram.module.ts` registers `TelegrafModule.forRootAsync` with middleware order
  `[allowlist, session()]`, i.e. the allowlist gate runs before Telegraf's session/scene machinery
  (`src/telegram/telegram.module.ts:12-32`).
- `telegram.update.ts` (`@Update()` class `TelegramUpdate`) — all top-level commands and inline
  button (`@Action`) callbacks.
- `newsearch.wizard.ts` (`@Scene('newsearch')` class `NewSearchWizard`) — the `/newsearch` step
  wizard, an in-process (per-scene) state machine.
- `allowlist.middleware.ts` — global Telegraf middleware gating every update.
- `telegram.copy.ts` — all user-facing Ukrainian strings + `describeProfile`/`esc` HTML helpers.
- `telegram.service.ts` — outbound sending (`TelegramService`), injected into the scheduler.
- `parsing.util.ts` — free-text range/owner/optional-text parsers used by the wizard (some
  exported helpers are unused in production code today — see §3.2).

### 2.3 `sources/`
- `listing.interface.ts` — shared `SearchCriteria`, `RawListing`, `Listing`, `listingKey()`,
  `KNOWN_SOURCE_IDS = ['domria', 'rieltor']`, `SOURCE_LABELS`
  (`src/sources/listing.interface.ts:8-70`).
- `listing-source.interface.ts` — the `ListingSource` abstraction contract: `fetchListings` "MUST
  NOT throw for expected failures ... return `[]`" (`src/sources/listing-source.interface.ts:9-27`).
- `http-listing-source.ts` — `HttpListingSource`, a generic runner for a declarative `SiteSpec`
  (URL-build + parse, or an imperative multi-step `fetch`), with retry/backoff, jittered delay,
  rotating User-Agent, and optional outbound proxy.
- `site-specs.ts` — the two concrete `SiteSpec`s: `rieltor` (HTML) and `domria` (2-step JSON API),
  keyed in `SITE_SPECS`.
- `source-registry.service.ts` — `SourceRegistry`, fans a search out to every **enabled**
  `ListingSource` concurrently, merges results, and is the scheduler's single dependency on the
  source layer.
- `sources.module.ts` — builds one `HttpListingSource` per **enabled** id from config
  (`src/sources/sources.module.ts:14-25`); an id with no matching spec (i.e. not in `SITE_SPECS`)
  is silently filtered out.
- `parsing.util.ts` — `toInt`/`toFloat`/`absoluteUrl`/`parseRieltor` (cheerio-based HTML scraping).
- `retry.util.ts` — `withRetry` (exponential backoff + full jitter) and `sleep`.

### 2.4 `search-profiles/`
- `search-profile.model.ts` — the `SearchProfile` shape, `matchesCriteria()` (client-side safety
  filter), `defaultProfileName()`.
- `search-profiles.service.ts` — `SearchProfilesService`: id minting, **one-filter-per-user**
  upsert/collapse logic, pause/resume, delete, `forgetUser`.
- `search-profiles.module.ts` — exports `SearchProfilesService`.

### 2.5 `persistence/`
- `redis.provider.ts` — a single shared `ioredis` client (`REDIS_CLIENT` token) with infinite
  capped-backoff retry (`retryStrategy: (times) => Math.min(times * 500, 5000)`,
  `maxRetriesPerRequest: null`) (`src/persistence/redis.provider.ts:26-32`) and graceful shutdown
  via `OnApplicationShutdown` (`src/persistence/redis.provider.ts:47-61`).
- `profiles.repository.ts` — `ProfilesRepository`: profile JSON + per-user/all-profile Redis sets.
- `seen-listings.repository.ts` — `SeenListingsRepository`: the per-profile seen **hash**
  (`listingId → price`).
- `persistence.module.ts` — `@Global()`, exports the client + both repositories.

### 2.6 `scheduler/`
- `scheduler.service.ts` — `SchedulerService`: the self-rescheduling polling loop
  (fetch-dedup → per-profile match/diff → notify → reschedule with jitter).
- `scheduler.module.ts` — imports `SourcesModule`, `SearchProfilesModule`, `TelegramModule`.

---

## 3. Functional behavior

### 3.1 Bot commands & menu

`TelegramUpdate` handlers (`src/telegram/telegram.update.ts`):

| Command / action | Handler | Behavior |
|---|---|---|
| `/start` | `onStart` (`telegram.update.ts:19-22`) | Replies with `WELCOME` (HTML) — intro + command list (`telegram.copy.ts:12-23`). |
| `/help` | `onHelp` (`telegram.update.ts:24-27`) | Replies with `HELP`, which is an alias of `WELCOME` (`telegram.copy.ts:25`). |
| `/newsearch` | `onNewSearch` (`telegram.update.ts:29-32`) | `ctx.scene.enter(NEWSEARCH_SCENE)` — launches the wizard (§3.2). |
| `/mysearches` | `onMySearches` (`telegram.update.ts:34-52`) | Lists the caller's profiles; if none, replies `NO_SEARCHES`. Otherwise sends a count line, then **one message per profile** (each with its own inline keyboard) via `describeProfile()`. |
| `/pause <id>` | `onPause` → `handleToggleCommand(ctx, true)` (`telegram.update.ts:54-57,205-226`) | Sets `paused=true` on the caller's profile matching `<id>`; missing arg → usage hint; profile not found/not owned → "не знайдено" reply. |
| `/resume <id>` | `onResume` → `handleToggleCommand(ctx, false)` | Symmetric to pause. |
| `/forgetme` | `onForgetMe` (`telegram.update.ts:64-78`) | Sends a confirm prompt with inline `forgetme:yes` / `forgetme:no` buttons — **does not delete immediately**. |
| `/cancel` | `NewSearchWizard.onCancel` (`newsearch.wizard.ts:68-72`) | Only meaningful *inside* the wizard scene: replies `CANCELLED`, removes the reply keyboard, leaves the scene. Outside the scene there is no `/cancel` handler in `TelegramUpdate`. |

Inline-button callbacks (`telegram.update.ts:82-167`):
- `pause:<id>` / `resume:<id>` → toggle + re-render the profile card in place.
- `del:<id>` → **guarded**: only a **paused** profile can proceed to a delete-confirm prompt
  (`delyes:<id>` / `delno:<id>`); an active profile gets an alert "Спершу призупиніть пошук,
  потім видаляйте" (`telegram.update.ts:104-108`).
- `delyes:<id>` → re-checks pause state (race guard) then deletes via
  `SearchProfilesService.delete`.
- `delno:<id>` → cancels, re-renders the card.
- `forgetme:yes` → calls `forgetUser(userId)`, edits the message with a count.
- `forgetme:no` → edits the message to "Скасовано. Ваші дані на місці."

**Command menu:** `TelegramService.onApplicationBootstrap` calls `bot.telegram.setMyCommands([...])`
once at startup, registering `newsearch, mysearches, pause, resume, forgetme, help, start`
(`src/telegram/telegram.service.ts:28-43`); failure here is caught and only logged (never blocks
boot).

### 3.2 The `/newsearch` wizard (state machine)

Implemented as a Telegraf scene, one filter-editing session per user, in-memory (`ctx.scene.state`)
— **not persisted to Redis until the final save** (`newsearch.wizard.ts:254-256`, and the module
comment "nothing is persisted until save()", `newsearch.wizard.ts:78`).

Stages (`type Stage`, `newsearch.wizard.ts:23`): `operation → city → rooms → price [→ priceManual]
→ area [→ areaManual] → save`.

- **EARS-001 (entry).** GIVEN a user sends `/newsearch`, WHEN the scene is entered, THEN the bot
  checks for an existing profile (`profiles.findByUser`) and replies with either a "новий фільтр"
  or "оновлюємо" intro plus the operation-choice keyboard
  (`OP_RENT` / `OP_SALE` / `❌ Відмінити`) (`newsearch.wizard.ts:52-66`).
- **EARS-002 (cancel, every step).** GIVEN the wizard is on any stage, WHEN the user sends
  `/cancel` OR any text containing `"відмін"` (case-insensitive), THEN the wizard replies
  `CANCELLED`, removes the keyboard, and leaves the scene without saving
  (`newsearch.wizard.ts:74-81`, `newsearch.wizard.ts:68-72`). Every stage's keyboard includes a
  `❌ Відмінити` button (e.g. `newsearch.wizard.ts:64,115,128,150,175,223,231`).
- **EARS-003 (operation).** WHEN the reply text contains `"оренд"`/`"rent"` → `operation='rent'`;
  contains `"продаж"`/`"sale"` → `operation='sale'`; otherwise the bot re-prompts without advancing
  (`newsearch.wizard.ts:104-117`).
- **EARS-004 (city — Kyiv only).** WHEN the reply doesn't match `/київ/i`, THEN the bot replies
  "Поки доступний лише Київ" and does not advance; a match sets `city='Київ'` literally (not the
  raw input) (`newsearch.wizard.ts:119-130`). **[Kyiv-only constraint enforced in the wizard.]**
- **EARS-005 (rooms).** Buttons `1,2,3,4+` and `Будь-яка`. `"будь"` → `rooms=undefined` (any);
  text starting with `"4"` → `rooms=4` (meaning "4+"); `"1"|"2"|"3"` → that exact number; anything
  else re-prompts (`newsearch.wizard.ts:132-142`).
- **EARS-006 (price).** Quick-pick buttons `до 10000 / до 20000 / до 30000` or `✏️ Інше` for manual
  entry (`newsearch.wizard.ts:219-225`). Manual entry stage (`priceManual`) accepts free text parsed
  by `parseRange()` (§3.2.1) (`newsearch.wizard.ts:144-161`).
- **EARS-007 (area).** Quick-pick buttons `30–60 / до 45 / до 80`, plus `Будь-яка` and `✏️ Інше`
  (`newsearch.wizard.ts:227-233`). `"будь"` (case-insensitive) explicitly clears `areaMin`/`areaMax`
  and **saves immediately** (`newsearch.wizard.ts:163-169`); `Інше`/`"інше"` goes to manual entry
  (`areaManual`) parsed the same way as price (`newsearch.wizard.ts:170-186`).
- **EARS-008 (range parsing — "lone number = максимум").** `parseRange()`
  (`src/telegram/parsing.util.ts:35-54`): two numbers → `{min, max}` (auto-swapped if reversed);
  a single bare number → **`{max: n}`** ("до"), *unless* the text contains `"від"` or ends in
  `"<digits>-"`, in which case it's `{min: n}`; a skip word (`-`, empty, `будь-яка`, `пропустити`,
  `skip`, `any`, `всі`, `усі`, `все`, `не важливо`, …) → `{}` (no constraint)
  (`src/telegram/parsing.util.ts:2-17,35-54`).
- **EARS-009 (save).** Builds a `SearchCriteria` with `operation ?? 'rent'`, the collected
  `city/rooms/priceMin/priceMax/areaMin/areaMax`, and **`ownerOnly: false` hard-coded**
  (`newsearch.wizard.ts:188-198`) — the wizard never asks an owner-only/realtor question despite
  `SearchCriteria.ownerOnly` existing and being consumed by `matchesCriteria` and the Rieltor spec
  (see §3.4). A default profile `name` is composed as `"<city> · <оренда|продаж>[ · N-кімн.]"`
  (`newsearch.wizard.ts:199-201`). Calls `SearchProfilesService.upsertForUser` (one filter per
  user; see §3.3), then replies with a "збережено"/"оновлено" confirmation containing
  `describeProfile(profile)`, and leaves the scene (`newsearch.wizard.ts:203-215`).
- **Resolved (was flagged).** Owner-only and district selection are **intentionally not built** into
  the wizard (deliberate scope-down; see [ADR-0002](../../../architecture/decisions/0002-one-filter-per-user.md)
  and the constitution's "deliberate scoping" principle). The helper leftovers
  (`parseOwnerChoice`, `OWNER_ONLY_LABEL`, `INCLUDE_ALL_LABEL`, `parseOptionalText`) were **removed as
  dead code** (review L-1 / PR #31). `criteria.ownerOnly` is always `false` and `criteria.district`
  is never set; DOM.RIA leaves district `undefined` (`site-specs.ts:96-98`), Rieltor's parser can
  populate it for display but the wizard has no district step to filter on.
- **Interrupted wizard.** An in-flight wizard session lost on restart simply restarts on the next
  `/newsearch`; already-saved profiles are unaffected (README, `README.md:345-346`) — this matches
  the in-memory `ctx.scene.state` design (no Redis-backed session persistence is implemented in
  this repo beyond Telegraf's own in-process `session()` middleware).

### 3.3 One filter per user, across all enabled sources

`SearchProfilesService.upsertForUser` (`src/search-profiles/search-profiles.service.ts:66-88`):
- GIVEN a user has no existing profile, WHEN `/newsearch` saves, THEN a new `SearchProfile` is
  created (`create()`, `search-profiles.service.ts:33-52`) with `primed: false`.
- GIVEN a user already has one or more profiles (`listByUser` returns `[keep, ...extra]`), WHEN
  `/newsearch` saves again, THEN the **first** listed profile (`keep`, sorted newest-first by
  `ProfilesRepository.loadMany`, `profiles.repository.ts:81-91`) has its `criteria`/`name`
  overwritten in place (id and other identity preserved) and `primed` is reset to `false` (re-prime
  with new criteria), and **any additional ("extra"/legacy) profiles are deleted** along with their
  seen-hashes — a comment calls this collapsing "legacy duplicates" from an "old one-per-site
  model" (`search-profiles.service.ts:60-65,72-88`).
- `findByUser` returns only `list[0]` (`search-profiles.service.ts:55-58`) — i.e. even before an
  upsert collapses duplicates, only the first profile is treated as "the" filter for wizard-entry
  detection.
- A profile is not scoped to one site: `SearchCriteria` has no `source`/`site` field
  (`listing.interface.ts:8-22`), and the scheduler queries `SourceRegistry.ids` (every enabled
  source) per profile (`scheduler.service.ts:101,121`) — confirming "one filter, all sites"
  (`README.md:18-19`).

### 3.4 Sources

Two sources are wired and enabled by default (`KNOWN_SOURCE_IDS`, `listing.interface.ts:64`;
default `SOURCES` env = "every known source", `configuration.ts:77`). Both are declared in
`SITE_SPECS` (`site-specs.ts:191-194`) and instantiated as `HttpListingSource` per enabled id
(`sources.module.ts:14-25`).

#### DOM.RIA (`domria`)
- **Official developer API** at `DOMRIA_BASE_URL` (default `https://developers.ria.com`), requires
  `DOMRIA_API_KEY`; without it, `fetch` returns `[]` immediately (`site-specs.ts:129-131`).
- **City mapping is Kyiv-only** in the shipped `DOMRIA_CITY_GEO` map (`Київ`/`Киев`/`Kyiv` →
  `{state:10, city:10}`, `site-specs.ts:45-49`); an unmapped city returns `[]` rather than
  "all-Ukraine", to avoid flooding the user with unmatched results (`site-specs.ts:43-44,133-134`).
- **2-step fetch:** (1) one `dom/search` call returning newest-first ids, with the criteria's
  `priceMin`/`priceMax` pushed into the request as `price_from`/`price_to` — the PR history
  (`adb2a2d`) explicitly did this "so premium listings surface" — plus `category=1`,
  `operation_type` (`'1'`=sale, `'3'`=rent), `state_id`/`city_id`, `lang_id=4`
  (`site-specs.ts:151-161`); (2) `dom/info/<id>` calls, but **only for ids not already known** to
  an in-memory per-search cache, capped at `cfg.domria.maxDetails` (default 10) per cycle
  (`site-specs.ts:113-119,166-176`).
- **In-memory cache** (`domriaCaches: Map<string, DomriaCache>`, module-level, resets on process
  restart) is keyed by `state:city:operation:priceFrom:priceTo` (`site-specs.ts:140`), so different
  price ranges never share cached ids/results. `known` (fetched-detail ids) is pruned each cycle to
  the current search window (ids are assumed monotonic — "older ids won't reappear")
  (`site-specs.ts:178-184`); `recent` (returned listings, newest-first) is capped at
  `DOMRIA_CACHE_SIZE = 60` (`site-specs.ts:114,180-182`).
- **Price is always normalized to UAH** via `info.priceArr['3']` (index 3 = UAH; DOM.RIA returns
  the same price pre-converted in every currency) — the raw `price`/`price_total` field is used
  *only* as a fallback when `currency_type_id === 3` (already UAH); otherwise price is `null`
  ("Ціна договірна") rather than mislabeling a foreign-currency figure as hryvnia
  (`site-specs.ts:72-84`).
- `district` is deliberately left `undefined` for DOM.RIA listings — "RIA's district is a
  neighbourhood, not the admin raion the user picks" (`site-specs.ts:96-98`); DOM.RIA therefore
  filters by city + price + area + rooms only, never district.
- `requestKey` for cross-profile dedup is `city|operation|priceMin|priceMax` (lower-cased city) —
  profiles differing only in area/rooms (client-side-only filters for this source) share one
  upstream fetch (`site-specs.ts:127-128`).
- `isBusiness` is derived as `advert_type_id === 2 || is_owner === 0` (`site-specs.ts:103`).

#### Rieltor (`rieltor`)
- Server-rendered HTML at `https://rieltor.ua/flats-rent/` or `/flats-sale/` depending on
  `operation` (`site-specs.ts:18-19,30-36`).
- URL filters pushed upstream: `price_min`/`price_max`; `rooms=N` for an **exact** 1–3 count only
  (no URL form for "4+", so rooms≥4 falls back to client-side filtering via `matchesCriteria`);
  `f-owners=1` when `ownerOnly` is true (`site-specs.ts:18-28`). **Area has no URL parameter** —
  filtered entirely client-side (`site-specs.ts:17`).
- Parsing (`parseRieltor`, `src/sources/parsing.util.ts:36-100`) reads each `.catalog-card`:
  `id` from `data-catalog-item-id`; `price` from `data-label` (assumed always UAH,
  `parsing.util.ts:32-34,84-85`); rooms/area regex-extracted from `.catalog-card-details` text;
  `district` = first region link matching `/р-н|район/i`; `isBusiness` = **not** containing
  "власник" in `.catalog-card-author-subtitle` (i.e. only an explicit "Власник" tag is treated as
  a private owner — realtor-first default) (`parsing.util.ts:70,92-94`). Returns `[]` on any parse
  exception (`parsing.util.ts:96-99`).

#### Registry / aggregation
- `SourceRegistry.fetchAll` runs every enabled source's `fetchListings` concurrently via
  `Promise.all`, catching per-source throws and substituting `[]` (double-guarded, since
  `HttpListingSource.fetchReal` already catches internally) (`source-registry.service.ts:59-71`,
  `http-listing-source.ts:80-100`).
- `SourceRegistry.fetchOne(sourceId, criteria)` is what the scheduler actually calls (§3.5), one
  source at a time, also `[]`-on-failure (`source-registry.service.ts:48-57`).
- `SourceRegistry.requestKey(sourceId, criteria)` delegates to the source's own `requestKey` (e.g.
  DOM.RIA's price-aware key) or falls back to `JSON.stringify(criteria)`
  (`source-registry.service.ts:39-42`, `http-listing-source.ts:72-76`).

### 3.5 Matching / client-side filtering

`matchesCriteria(listing, criteria)` (`src/search-profiles/search-profile.model.ts:33-59`) is a
**client-side safety net** applied to every fetched listing regardless of what a source's own
URL/API filters already did (comment: "even if the scraper's URL filters are imperfect ... never
notify about something outside the range", `search-profile.model.ts:30-32`):
- `ownerOnly && listing.isBusiness` → excluded.
- **`listing.price == null` → always excluded** ("Ціна договірна" listings are dropped — "can't be
  judged against a budget and the user asked not to see these", `search-profile.model.ts:36-38`).
- `priceMin`/`priceMax` bounds checked when set.
- `areaMin`/`areaMax` bounds checked only when `listing.area !== null` (a null area is *not*
  excluded, unlike a null price) (`search-profile.model.ts:42-45`).
- `rooms`: `criteria.rooms >= 4` means "4 or more"; otherwise an exact match; only applied when
  `listing.rooms` is present (`search-profile.model.ts:48-50`).
- `district`: case-insensitive substring match of `criteria.district` inside `listing.district`,
  only applied when both are present (`search-profile.model.ts:52-56`). Given the wizard never
  collects a district (§3.2), `criteria.district` is effectively always `undefined` today, so this
  branch is dead in practice — intentionally (no district wizard step; deliberate scope-down).

### 3.6 Notification logic

`SchedulerService.runCycle` / `processProfile` / `deliver`
(`src/scheduler/scheduler.service.ts:93-199`):

1. **Load & filter active profiles.** `profiles.listAll()` then drop `paused` ones
   (`scheduler.service.ts:94-99`).
2. **Fetch-dedup across profiles.** For every `(sourceId, requestKey(criteria))` pair not already
   in the cycle's cache, fetch once via `sources.fetchOne` and cache the result — so N profiles
   with the same effective upstream request (e.g. same city+operation+price for DOM.RIA) trigger
   exactly one HTTP call per source per cycle (`scheduler.service.ts:101-117`).
3. **Per-profile processing**, isolated in its own `try/catch` so one profile's failure doesn't
   stop others (`scheduler.service.ts:119-129`):
   - Merge the cached listings from every enabled source for this profile's criteria, then filter
     with `matchesCriteria` (`scheduler.service.ts:121,133`).
   - **EARS-010 (first-poll priming).** GIVEN `profile.primed === false`, WHEN the cycle runs,
     THEN the newest `INITIAL_SHOW = 5` matches are **shown** (notified) and the remainder are
     **silently seeded** into the seen-hash (`seed()`, no notification); `profile.primed` is then
     set `true` and persisted (`scheduler.service.ts:28-29,139-157`). Sources are assumed
     newest-first so `matched.slice(0, 5)` is "freshest" (`scheduler.service.ts:138`).
   - **EARS-011 (steady-state diff).** GIVEN `profile.primed === true`, WHEN a matched listing's
     `listingKey()` (`"source:id"`) is **not** in the profile's seen-map → notify "new listing"
     (`notifyNewListing`); WHEN it **is** present but the stored price differs from the current
     price → notify "price changed" (`notifyPriceChange`, passing the old price); WHEN present and
     unchanged → no action (`scheduler.service.ts:159-176`).
   - **EARS-012 (seen recorded only after successful send).** `deliver()` calls `send()` first;
     `seen.markSeen(...)` runs **only if `send()` resolves**. If `send()` throws, the error is
     logged as a warning and the listing is left unseen, "will retry next cycle"
     (`scheduler.service.ts:183-199`).
4. **Reschedule.** `scheduleNext(nextDelay())` computes `intervalMs ± jitterMs` (uniformly
   randomized, floored at 5000 ms) and reschedules via `setTimeout`
   (`scheduler.service.ts:65-73`). A first tick fires 8000 ms after `onModuleInit`
   (`scheduler.service.ts:50-57`). If a cycle is still `running` when the timer fires, that beat is
   skipped rather than overlapped (`scheduler.service.ts:76-80`).
5. **Cycle-level resilience.** `tick()` wraps `runCycle()` in try/catch so an uncaught error there
   still reschedules the next cycle (`scheduler.service.ts:82-89`).

`TelegramService` (`src/telegram/telegram.service.ts`):
- `notifyNewListing` / `notifyPriceChange` build an HTML caption (title, price [new-listing only —
  price-change instead shows an old→new strikethrough line with a 📉/📈/💱 arrow depending on
  direction], area, city/district, owner-vs-agency + source label, the profile name, and a link)
  and send it via `sendPhoto` (with `listing.imageUrl`) or, on photo-send failure or absent image,
  a fallback `sendMessage` (`telegram.service.ts:45-134`).
- These methods **throw** on a genuine send failure (after the photo→text fallback also fails) —
  this is the explicit contract the scheduler relies on for "mark seen only after success"
  (`telegram.service.ts:9-16`).

### 3.7 Access control

`createAllowlistMiddleware(allowedIds)` (`src/telegram/allowlist.middleware.ts`):
- Builds a `Set` from `ALLOWED_USER_IDS` (parsed in `configuration.ts:53-57,84`).
- **Fails closed:** an empty allowlist rejects everyone and logs a startup warning
  (`allowlist.middleware.ts:14-18`); `README.md:293` documents "empty = nobody".
- For every update, if `ctx.from.id` is not in the set, the middleware replies
  `ACCESS_RESTRICTED` (best-effort — a `ctx.reply` failure, e.g. the user blocked the bot, is
  swallowed) and does **not** call `next()`, stopping all further processing
  (`allowlist.middleware.ts:20-35`). Applied globally before `session()` (`telegram.module.ts:22-24`).

---

## 4. Data model

Redis-only. All keys are prefixed with `REDIS_KEY_PREFIX` (default `'olx'` — historical, from when
OLX was the sole source; **no longer a source id**, per the code comment in
`configuration.spec.ts:30` and the `.env.example` note calling it just "namespaces every key").

| Key pattern | Redis type | Written by | Purpose |
|---|---|---|---|
| `{p}:profile:{id}` | String (JSON `SearchProfile`) | `ProfilesRepository.save` (`profiles.repository.ts:39-46`) | Full profile record. |
| `{p}:user:{userId}:profiles` | Set of profile ids | `ProfilesRepository.save`/`delete` | Index for `/mysearches`, `findByUser`, `/forgetme`. |
| `{p}:profiles:all` | Set of profile ids | `ProfilesRepository.save`/`delete` | The scheduler's iteration source (`profiles.listAll()`). |
| `{p}:seen:{profileId}` | Hash `listingKey → price` | `SeenListingsRepository` (`seen-listings.repository.ts`) | Dedup **and** price-change detection. `listingKey` = `"source:id"` (`listing.interface.ts:56-58`), so the same physical flat on two sites is tracked independently. |

`SearchProfile` shape (`src/search-profiles/search-profile.model.ts:7-27`):
```ts
{ id: string; userId: number; chatId: number; name: string;
  criteria: SearchCriteria; paused: boolean; primed: boolean; createdAt: number }
```
`SearchCriteria` shape (`src/sources/listing.interface.ts:8-22`):
```ts
{ city: string; district?: string; priceMin?: number; priceMax?: number;
  areaMin?: number; areaMax?: number; ownerOnly: boolean;
  operation?: 'rent' | 'sale'; rooms?: number }
```
Price encoding in the seen-hash: a `null` price is stored as the **literal string `"null"`** (not
absence) so "договірна" listings register as seen and don't perpetually re-fire
(`seen-listings.repository.ts:14-16,32-41`).

Profile ids are 8 hex characters (`randomBytes(4).toString('hex')`,
`search-profiles.service.ts:23-25`) — short enough to type into `/pause <id>`.

Non-Redis, **in-memory, per-process** state (lost on restart, not part of the "official" data
model): the DOM.RIA `domriaCaches` map (`site-specs.ts:119`) and the wizard's `ctx.scene.state`
(Telegraf's in-memory session).

---

## 5. Non-functional behavior

### 5.1 Resilience
- **Per-source isolation:** `ListingSource.fetchListings` contractually never throws
  (`listing-source.interface.ts:9-12`); `HttpListingSource.fetchReal` catches and logs, returning
  `[]` (`http-listing-source.ts:80-100`); `SourceRegistry` catches again around every call
  (`source-registry.service.ts:48-57,59-71`) — double-guarded.
- **Per-profile isolation:** each profile is processed in its own try/catch in `runCycle`
  (`scheduler.service.ts:119-129`).
- **Per-notification isolation:** `deliver()` catches send failures per listing, logs, and leaves
  the listing unseen for a retry next cycle (`scheduler.service.ts:183-199`).
- **Cycle-level isolation:** `tick()` catches any error from `runCycle()` so the schedule
  continues (`scheduler.service.ts:82-89`).
- **Redis resilience:** infinite capped-backoff reconnect (`redis.provider.ts:26-32`); state lives
  only in Redis (no in-memory "seen" cache), so a restart cannot cause duplicate notifications by
  design (matches `CLAUDE.md`'s resilience requirement).
- **Overlap guard:** a still-running cycle causes the next tick to be skipped, not queued/overlapped
  (`scheduler.service.ts:76-80`).

### 5.2 Scraping etiquette (`src/sources/http-listing-source.ts`)
- **Jittered poll interval:** `POLL_INTERVAL_MS ± POLL_JITTER_MS`, uniformly random, floor 5000 ms
  (`scheduler.service.ts:70-73`).
- **Retry with exponential backoff + full jitter:** `withRetry` — `base * 2^attempt` capped at
  `maxDelayMs`, actual wait randomized in `[exp/2, exp]` (`retry.util.ts:18-37`), applied to every
  HTML/JSON fetch with `retries: cfg.maxRetries` (default 3), `baseDelayMs: 800`,
  `maxDelayMs: 8000` (`http-listing-source.ts:103-114,117-129`).
- **Rotating User-Agent:** one of 3 hardcoded desktop Chrome UAs, chosen randomly per request
  (`http-listing-source.ts:41-45,132-134`).
- **Small random pre-request delay:** `sleep(random 0–400ms)` before HTML fetches, `0–300ms`
  before JSON fetches (`http-listing-source.ts:105,120`).
- **Optional outbound proxy:** `HTTP_PROXY_URL`, parsed into axios' `proxy` config, supporting
  basic auth in the URL (`http-listing-source.ts:136-155`).
- **Identical-search dedup:** the scheduler fetches each unique `(source, requestKey)` at most once
  per cycle, shared across all profiles that resolve to it (`scheduler.service.ts:101-117`).
- **DOM.RIA-specific throttling:** `DOMRIA_MAX_DETAILS` caps detail-fetch calls per cycle per
  unique DOM.RIA search (`site-specs.ts:167`), and the in-memory cache means only *new* ids incur a
  detail call on subsequent cycles (`site-specs.ts:108-119`).

### 5.3 Configuration / environment variables
Sourced from `.env.example` and `src/config/configuration.ts`:

| Var | Default | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — (required) | Validated shape `<digits>:<hash>` (`configuration.ts:60-72`). |
| `ALLOWED_USER_IDS` | `[]` | CSV of numeric ids; empty ⇒ nobody allowed (`configuration.ts:53-57,84`; `allowlist.middleware.ts:14-18`). |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Overridden to `redis://redis:6379` in Compose (`docker-compose.yml:24`). |
| `REDIS_KEY_PREFIX` | `olx` | Legacy namespace label, not a source (`configuration.ts:88`). |
| `POLL_INTERVAL_MS` | `300000` (5 min) | `configuration.ts:91`; prod default overridden to `600000` via a repo **Variable** in the deploy workflow (`.github/workflows/deploy.yml:110`). |
| `POLL_JITTER_MS` | `60000` | `configuration.ts:92`. |
| `SOURCES` | all known (`domria,rieltor`) | CSV, unknown ids dropped (`configuration.ts:74-79`). |
| `DOMRIA_API_KEY` | — | Required for real DOM.RIA data; absent ⇒ `[]` (`site-specs.ts:130-131`). |
| `DOMRIA_BASE_URL` | `https://developers.ria.com` | `configuration.ts:100`. |
| `DOMRIA_MAX_DETAILS` | `10` | `configuration.ts:105`; also a Compose pass-through and deploy-workflow var. |
| `HTTP_PROXY_URL` | — | Optional, shared by all sources (`configuration.ts:98`). |
| `SCRAPER_TIMEOUT_MS` | `15000` | Axios request timeout (`configuration.ts:96`, `http-listing-source.ts:55`). |
| `SCRAPER_MAX_RETRIES` | `3` | `configuration.ts:97`. |
| `LOG_LEVEL` | `log` | Cumulative Nest log levels (`main.ts:6-11`). |

### 5.4 Deployment / isolation
- `docker-compose.yml` defines exactly two services, `app` and `redis`, on a dedicated bridge
  network `flat-hunter-net`, no `ports:` mapping on `app`, `redis` only reachable inside the
  network (`docker-compose.yml:16-64`).
- `redis` runs with `--appendonly yes` for restart-durable state (`docker-compose.yml:51`) and a
  healthcheck (`redis-cli ping`) gating `app`'s `depends_on` (`docker-compose.yml:40-58`).
- Secrets (`TELEGRAM_BOT_TOKEN`, `ALLOWED_USER_IDS`, `HTTP_PROXY_URL`, `DOMRIA_API_KEY`) are
  pass-through env vars (bare names in `environment:`, i.e. taken from the host/deploy-shell
  environment) — never written to a file on the droplet; the deploy explicitly `rm -f`s any legacy
  `.env` (`docker-compose.yml:34-39`, `.github/workflows/deploy.yml:100-105`).
- `Dockerfile` is a two-stage build (`node:20-alpine` builder → pruned runtime), runs as the
  non-root `node` user, no `EXPOSE` (`Dockerfile:1-31`).

---

## 6. Explicit constraints / non-goals reflected in code

- **Redis-only, no relational store.** No SQL/ORM dependency in `package.json`; the model is
  string/JSON + sets/hashes only (§4).
- **Kyiv-only city coverage today.** Wizard hard-restricts to `/київ/i` (`newsearch.wizard.ts:119-124`);
  DOM.RIA's geo map has only Kyiv entries (`site-specs.ts:45-49`); Rieltor's URL path defaults to
  the Kyiv catalog with no city parameter (`site-specs.ts:14-17`).
- **No webhook / no inbound HTTP.** `NestFactory.createApplicationContext` (not
  `NestFactory.create`), no `EXPOSE`, no published ports (§1, §5.4).
- **No web dashboard.** No controllers, no `@nestjs/platform-express`/`fastify` dependency in
  `package.json`; the only interface is Telegram commands/callbacks.
- **One filter per user** (not one-per-site) — enforced structurally by `upsertForUser` collapsing
  to a single kept profile (`search-profiles.service.ts:66-88`); this is described as a deliberate
  evolution away from an "old one-per-site model" (`search-profiles.service.ts:63-64`).
- **No price history / trend store.** Only current-vs-last-seen comparison; the seen-hash stores a
  single latest price per listing, not a series (`seen-listings.repository.ts`); confirmed by
  README as an explicit scope limit (`README.md:341-342`).
- **OLX removed entirely.** Commit `9c61511` "chore: remove OLX entirely" (per git log) and the
  README explicitly lists OLX among sources "Dropped after evaluation ... Cloudflare-block the
  droplet's datacenter IP" (`README.md:103-105`). No `olx` entry remains in `SITE_SPECS` or
  `KNOWN_SOURCE_IDS` (`site-specs.ts:191-194`, `listing.interface.ts:64`) — the surviving `olx`
  string in the codebase is only the `REDIS_KEY_PREFIX` default, a naming artifact.

---

## 7. Glossary

| Term | Meaning in this codebase |
|---|---|
| **Profile** (`SearchProfile`) | A user's single saved filter (criteria + pause/primed state), one per Telegram user (`search-profile.model.ts:7-27`). |
| **Criteria** (`SearchCriteria`) | The filter fields: city, district, price/area range, rooms, operation, ownerOnly (`listing.interface.ts:8-22`). |
| **Source** (`ListingSource`) | One housing site adapter (`domria` or `rieltor`) implementing a common fetch contract (`listing-source.interface.ts`). |
| **SiteSpec** | The declarative (or imperative) recipe `HttpListingSource` executes for a given source (`http-listing-source.ts:19-30`, `site-specs.ts`). |
| **Listing** | A normalized ad from a source, tagged with `source`/`sourceLabel` (`listing.interface.ts:44-49`). |
| **listingKey** | `"source:id"` — the global dedup key preventing numeric-id collisions across sites (`listing.interface.ts:56-58`). |
| **Seen hash** | Per-profile Redis hash `listingKey → lastPrice`, the dedup + price-change store (`seen-listings.repository.ts`). |
| **Priming** | The first poll of a new/edited profile: show a few current matches, silently seed the rest, so activation doesn't flood the user (`scheduler.service.ts:132-157`). |
| **requestKey** | A source-defined key identifying the *actual* upstream request, used to dedup fetches across profiles that differ only in client-side-filtered fields (`listing-source.interface.ts:19-26`). |
| **Allowlist** | The static `ALLOWED_USER_IDS` set gating all bot interaction (`allowlist.middleware.ts`). |
| **DOM.RIA cache** (`domriaCaches`) | An in-memory, per-process, per-search cache of known/recent DOM.RIA listing ids, resetting on restart (`site-specs.ts:113-119`). |

---

## Open items flagged for review (not addressed here)

- Wizard does not collect `district` or `ownerOnly` despite both fields existing in
  `SearchCriteria` and being consumed by matching/source logic (§3.2, §3.5).
- `REDIS_KEY_PREFIX` default `olx` is a legacy artifact from a removed source and may be confusing
  to new operators (§4, §6).
- `parseOwnerChoice`/`parseOptionalText`/`OWNER_ONLY_LABEL`/`INCLUDE_ALL_LABEL` are dead code in
  production paths (§3.2).
