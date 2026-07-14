# Flat Hunter Bot — Project Brief for Claude Code

Repo: `flat-hunter-bot`

## Goal
Build a Telegram bot that monitors Ukrainian rental-housing listings against user-defined filters and sends instant notifications when new matching listings appear.

## Current state (updated after implementation — this section wins where it contradicts the original brief below)
The brief below is the **original** spec; the shipped design has since evolved. Where they conflict, follow this:
- **Sources:** live = **DOM.RIA** (official API) + **Rieltor** (server-rendered HTML). OLX / lun / flatfy have adapters but Cloudflare-block the droplet's datacenter IP (403) — they need a residential proxy (`HTTP_PROXY_URL`); OLX was later removed entirely. birdrent / josti were app-only (no web catalog) and dropped. So it is **not** an "OLX bot" — the OLX references throughout the brief are historical.
- **One filter per user, across all sites** — NOT multiple independent profiles. `/newsearch` upserts a single profile that is queried against every enabled source; each alert is tagged with its source. (The "Multiple profiles per user" requirement below is superseded.)
- **Wizard steps:** operation (rent/sale) → city (**Kyiv only** for now) → rooms → price → area. There is **no** district step and **no** owner-only toggle step (the `district`/`ownerOnly` criteria fields exist but the wizard doesn't collect them).
- **Prices are normalized to UAH** (DOM.RIA via `priceArr`, Rieltor via the NBU-equivalent in the card); listings with no price are excluded.
- **`REDIS_KEY_PREFIX` defaults to `olx`** — a legacy namespace from the project's original name, **not** a source. ⚠️ Renaming it orphans all live Redis data (profiles + seen-hashes); treat a change as a data migration, not an env edit.
- Everything else (Redis-only, Docker isolation, no ports, long polling, allowlist, deploy pattern) matches the brief.

## Deployment context (read first)
- This runs on an existing DigitalOcean droplet that already hosts another project (`aurora`, under `/opt/aurora/`).
- Deploy this project fully isolated under `/opt/flat-hunter-bot/` — separate docker-compose stack, separate Docker network, no shared containers with the existing project.
- **No ports exposed to the host.** The bot only makes outbound calls (Telegram API, OLX) — it needs zero inbound exposure, so there's nothing to route through nginx and no conflict with whatever the existing project listens on.
- **No domain, no SSL, no webhook.** Telegram integration uses long polling exclusively.
- Deployment should follow the same pattern already used for `aurora`: SSH into the droplet, `mkdir -p` the target directory if missing, then `docker-compose up -d`.

## Tech stack
- Node.js + NestJS + TypeScript
- Telegram: a well-maintained NestJS-friendly library (e.g. Telegraf via `nestjs-telegraf`), long polling mode
- Persistence: **Redis only** — deliberately no PostgreSQL. The data is flat (dedup + flat filter profiles), not relational, so a relational DB would be over-engineering here regardless of how many people use the bot.
    - Redis Hash per profile → `{ listingId: lastKnownPrice }`. Presence of the ID covers dedup; a stored price that differs from the freshly-scraped price signals a price change worth re-notifying about. (A plain Set of IDs only tells you "seen or not" — it can't catch a price change on a listing already shown, so a Hash is the one-line fix.)
    - Redis hash/JSON → filter profiles per user
- Docker Compose: two services (`app`, `redis`), isolated network, no exposed ports

## Functional requirements

### Filters (per search profile)
- City
- District
- Price range (min–max)
- Area range (min–max, m²)
- Toggle: owner-only vs. include realtors

### Multiple profiles per user
One Telegram user can run several independent filter profiles at once (e.g. "apartment for me" + "garage as investment"). Each profile polls and notifies independently of the others.

### Polling & notifications
- Poll on a configurable interval (start conservative — e.g. 5–10 min; see scraping etiquette below)
- Diff fresh listings against the "already seen" Redis hash for that profile
- New listing (ID not in hash) → Telegram message with title, price, area, district, link, thumbnail (if available)
- Existing listing with a changed price (ID in hash, stored price ≠ current price) → Telegram message noting the price change (old → new)
- Update the stored price / mark as seen **immediately after a successful send**, not before — so a crash mid-notify doesn't silently swallow it
- Out of scope for this iteration: full price *history* (multiple points over time, trend queries) — only current-vs-last-seen is compared. If that's wanted later, that's the trigger to add a proper time-series store (SQLite/Postgres)

### Bot commands
- `/start` — welcome + short how-to
- `/newsearch` — step-by-step wizard: city → district → price → area → owner-only toggle
- `/mysearches` — list active profiles; edit or delete
- `/pause <id>` / `/resume <id>` — toggle a profile without deleting it

### Access control
- Bot is limited to a restricted group, not open to the public — needs an allowlist, not open signup
- Simplest v1: a static list of permitted Telegram user IDs via env var (e.g. `ALLOWED_USER_IDS=123456,789012`), checked before any command runs
- A user not on the list gets a polite "access restricted" reply — not silence, not a raw error
- Adding/removing someone means editing the env var and redeploying, which is fine for a list that changes rarely. If the group grows or turns over often, move the allowlist into Redis (a Set) instead so it updates without a redeploy — same infra, no new moving parts
- `/forgetme` — deletes all of a user's profiles and stored data on request (cheap to keep even for a small group)

## Non-functional requirements

### Resilience
- "Already seen" state lives in Redis, never in memory — a restart must not cause duplicate notifications
- One user's Telegram API error (blocked bot, rate limit) must not crash the polling loop for everyone else

### OLX access & scraping etiquette
- OLX has no reliable public API for this use case — this will be a scraper
- Datacenter IP ranges (including this droplet) are sometimes rate-limited or blocked by anti-scraping measures. Build the scraping module behind an interface/abstraction so the approach (direct fetch vs. proxy) can change later without touching the rest of the app
- Randomize poll intervals slightly, use a realistic User-Agent, implement retry-with-backoff on failures
- Worth deduplicating identical searches (same city + district + price/area range) into one OLX fetch per polling cycle rather than one per profile, to keep request volume sane as the group grows

## Open decisions (fill in before/while building)
- Exact OLX market/domain to target (affects scraper selectors and URL structure)
- User-facing bot copy language (Ukrainian by default, unless stated otherwise)

## Explicit non-goals for this iteration
- No PostgreSQL / relational schema
- No web dashboard
- No webhook mode
- No domain or SSL setup

## Suggested module structure
Propose your own NestJS module breakdown, but it should roughly separate:
- `telegram/` — bot commands, message formatting
- `olx-scraper/` — fetching + parsing listings, abstracted behind an interface
- `search-profiles/` — CRUD for user filter profiles
- `persistence/` — Redis client + repository-style access
- `scheduler/` — polling loop, one job per active profile

## Deliverables for this session
1. Scaffolded NestJS project with the structure above
2. Redis-backed persistence for profiles + seen-listing IDs
3. Telegram commands as specified
4. Initial OLX scraper module (a stub/mock is fine to start — real scraping logic can iterate)
5. `docker-compose.yml` for local dev and for droplet deployment
6. `README.md` with setup steps and `.env.example`