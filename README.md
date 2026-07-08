# Flat Hunter Bot 🏠🔎

A Telegram bot that monitors **Ukrainian housing sites** against a user-defined
filter and sends **instant notifications** when a new matching listing appears —
or when the price of one you've already seen changes. You set the criteria once
and it searches **every enabled site**; each alert says which site it came from.
**DOM.RIA** and **Rieltor** are live today (real data). The engine also has working
adapters for OLX, ЛУН, Flatfy, BirdRent and Josti — but OLX and ЛУН Cloudflare-block
the droplet's datacenter IP (403), so they need a residential proxy to enable.

Built with **NestJS + TypeScript**, **Telegraf** (long polling, no webhook) and
**Redis** for all state. Runs as an isolated Docker Compose stack with **no
inbound ports** — it only makes outbound calls to Telegram and the housing sites.

---

## Features

- **One filter, all sites** — set the criteria once; every enabled site is
  searched each cycle and each alert shows its source. Dedup is namespaced per
  site (`source:id`), so the same flat on two sites can't collide.
- **Filters:** operation (rent/sale), city, rooms, price range, area range (m²).
- **New-listing + price-change alerts** with title, price, area, district, link,
  thumbnail, and the source site.
- **Allowlist access control** — only permitted Telegram user IDs can use the bot.
- **Resilient by design** — dedup state lives in Redis (restart-safe); one
  user's error never stops polling for everyone else; a broken/blocked source
  never throws into the loop (returns `[]`).
- **Scraping etiquette** — jittered poll intervals, rotating realistic
  User-Agents, retry-with-backoff, per-request delays, and identical searches
  deduped into one fetch per cycle. See [Rate limits](#rate-limits--avoiding-blocks).

---

## Bot commands

| Command | What it does |
|---|---|
| `/start`, `/help` | Welcome + how-to |
| `/newsearch` | Step-by-step wizard: operation → city → rooms → price → area |
| `/mysearches` | List your profiles with inline **Pause / Resume / Delete** buttons |
| `/pause <id>` | Pause a profile (keeps its data) |
| `/resume <id>` | Resume a paused profile |
| `/forgetme` | Delete **all** your profiles and stored data |
| `/cancel` | Abort the `/newsearch` wizard at any step |

User-facing copy is **Ukrainian** by default (targets Ukrainian housing sites).

---

## Architecture

NestJS modules, roughly one per concern:

```
src/
├── config/           # typed env parsing (one place for defaults/validation)
├── telegram/         # bot commands, /newsearch wizard, allowlist, notifications
├── sources/          # ListingSource interface, per-site specs, registry/aggregator
├── search-profiles/  # profile model + CRUD/lifecycle service
├── persistence/      # single Redis client + repository-style access
└── scheduler/        # the jittered polling loop (dedup → diff → notify)
```

**Data model (Redis only — no SQL, by design).** The data is flat (dedup + flat
filter profiles), so a relational DB would be over-engineering.

| Key (`{p}` = `REDIS_KEY_PREFIX`) | Type | Purpose |
|---|---|---|
| `{p}:profile:{id}` | JSON string | a `SearchProfile` |
| `{p}:user:{userId}:profiles` | Set | a user's profile ids |
| `{p}:profiles:all` | Set | every profile id (scheduler iterates this) |
| `{p}:seen:{profileId}` | **Hash** `source:id → lastPrice` | dedup **and** price-change detection |

The seen-**hash** (not a plain set) is the key trick: a stored price differing
from the freshly-scraped price is exactly the signal for a "price changed"
re-notification. Seen state is updated **only after a successful send**, so a
crash mid-notify re-tries next cycle instead of silently swallowing the alert.

**First-poll priming.** When a profile is first polled, its current matches are
recorded silently (no messages) so activating a search doesn't blast you with
every listing that already exists — you only hear about genuinely new ones from
then on.

### The source engine

Everything talks to the `ListingSource` interface. A `SourceRegistry` fans one
search out to every **enabled** source concurrently and merges the results — the
scheduler never knows or cares which sites are active. Adding a site = add a
compact `SiteSpec` in `src/sources/site-specs.ts` and its id to
`KNOWN_SOURCE_IDS`; no other wiring changes.

Which sites are active is set by **`SOURCES`** (comma-separated). A user has **one
filter** that queries **every enabled site** — `/newsearch` asks the criteria
once (operation → city → rooms → price → area), and each cycle checks all sources
(DOM.RIA + Rieltor today), tagging each alert with its origin. Results are
namespaced by `source:id`, so the same listing on two sites can't collide.

| id | Site | data |
|---|---|---|
| `domria` | dom.ria.com | **official API** (needs `DOMRIA_API_KEY`) — real, tuned |
| `rieltor` | rieltor.ua | HTML (server-rendered cards) — real, verified live |
| `olx` | OLX.ua | HTML (`__NEXT_DATA__` → cards) — blocked from datacenter IPs (403) |
| `lun` | lun.ua | HTML (ld+json + `page_id`) — real parser (+NBU $/€→грн), but **403 from datacenter IP → needs a proxy** |
| `flatfy` | flatfy.ua | HTML/SPA — best-effort, not yet wired |
| `birdrent` | birdrent.com | HTML — best-effort, not yet wired |
| `josti` | josti.com.ua | HTML — best-effort, not yet wired |

⚠️ **The HTML parsers are best-effort.** DOM.RIA exposes a stable public API and
Rieltor's cards are parsed from verified live markup; the rest need tuning against
the live sites and are defensive (return `[]`
on mismatch). DOM.RIA also filters by city geo-id (Kyiv mapped; add more as
needed) and skips raion-level filtering for now.

---

## Rate limits & avoiding blocks

DOM.RIA's API is 2-step (one search call + one detail call per listing), so it
does up to `DOMRIA_MAX_DETAILS` (default **10**) detail calls per search — the
biggest request amplifier, which is why it's capped and configurable.

Two realistic failure modes:

1. **DOM.RIA API quota** — with a free key, heavy polling can exhaust the daily
   quota. Mitigate: keep `DOMRIA_MAX_DETAILS` low and `POLL_INTERVAL_MS`
   conservative.
2. **Anti-scraping on the HTML sites** — the droplet is a datacenter IP, which
   the HTML sites may rate-limit or block (relevant once those are wired).

**What's already built in** (`src/sources/http-listing-source.ts`): jittered
poll interval (`POLL_INTERVAL_MS ± POLL_JITTER_MS`), retry with exponential
backoff + full jitter, rotating User-Agents, a small random delay before every
request, and **identical-search dedup** (one fetch per unique per-site search
per cycle).

**Knobs to turn down the volume:** raise `POLL_INTERVAL_MS` (e.g. 600000 =
10 min), lower `DOMRIA_MAX_DETAILS`, trim `SOURCES`, or set `HTTP_PROXY_URL`
(residential/rotating proxy) to dodge datacenter-IP blocks.

---

## Local development

### Prerequisites
- Node.js ≥ 20
- A running Redis (locally: `docker run -p 6379:6379 redis:7-alpine`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your numeric Telegram user id (from [@userinfobot](https://t.me/userinfobot))

### Steps
```bash
# 1. Install deps
npm install

# 2. Configure
cp .env.example .env
#   set TELEGRAM_BOT_TOKEN and ALLOWED_USER_IDS (at minimum)
#   set DOMRIA_API_KEY for real DOM.RIA data (SOURCES=domria)
#   set REDIS_URL=redis://127.0.0.1:6379 for a local redis

# 3. Run (watch mode)
npm run start:dev
```

Then message your bot: `/start` → `/newsearch`. With a DOM.RIA key set you'll
get real listings within a poll cycle.

> Tip: lower `POLL_INTERVAL_MS` (e.g. `20000`) while developing to see alerts
> quickly.

---

## Deployment

Runs fully isolated under `/opt/flat-hunter-bot/`, separate from the existing `aurora`
stack: its own Compose project, its own bridge network, its own Redis volume,
**no published ports**.

There is **no `.env` file on the droplet** and **no manual bootstrap step**.
Secrets live only in GitHub Actions Secrets and are injected into the container
at deploy time (see below). Just configure the secrets once and push to `main`.

### Secrets stay off the droplet's disk

Instead of a plaintext `.env` sitting in `/opt/flat-hunter-bot/`, the deploy passes
`TELEGRAM_BOT_TOKEN` / `ALLOWED_USER_IDS` / `HTTP_PROXY_URL` into the deploy
shell over the encrypted SSH channel (via stdin — never as `ps`-visible args and
never to a file), and Compose's pass-through `environment:` hands them to the
container at `up`. The deploy also `rm -f`s any legacy `.env`.

> **Caveat, stated honestly:** env vars given to a container are still recorded
> by Docker in its container config on disk (`docker inspect`, root-only) — that
> is inherent to any containerized env var. This design removes the standalone,
> backup-prone `.env` file and centralizes rotation in GitHub; it does **not**
> defend against a root-level compromise of the droplet. For that tier, use an
> external secrets manager.

Updating the allowlist = edit the `FLAT_HUNTER_ALLOWED_USER_IDS` **GitHub secret** and re-run
the deploy (Actions → Run workflow). No SSH, no file edit.
(If the group turns over often, the allowlist can move into a Redis Set later —
same infra, no redeploy. See `src/telegram/allowlist.middleware.ts`.)

---

## CI/CD — automated deploy (GitHub Actions → DigitalOcean)

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs on every push
and PR:

- **`build`** (all pushes + PRs): `npm ci` + `npm run build` — the typecheck gate.
- **`deploy`** (push to `main` or manual **Run workflow**): `rsync`es the repo to
  `/opt/flat-hunter-bot/`, then runs `docker compose up -d --build` on the droplet and a
  post-deploy health check that fails the run if a container crash-loops.

No container registry — the droplet builds its own image, matching the `aurora`
pattern. Deploys are serialized (`concurrency`) so two pushes can't collide.

### Required GitHub repository secrets

Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Required | What it is |
|---|:--:|---|
| `DO_FLAT_HUNTER_SSH_PRIVATE_KEY` | ✅ | Private key (full PEM contents) of a deploy keypair whose **public** key is in the droplet user's `~/.ssh/authorized_keys` |
| `DO_FLAT_HUNTER_HOST` | ✅ | Droplet IP or hostname |
| `DO_FLAT_HUNTER_USER` | ✅ | SSH user (`root`, or a deploy user in the `docker` group) |
| `DO_FLAT_HUNTER_SSH_PORT` | — | SSH port if not `22` |
| `FLAT_HUNTER_TELEGRAM_BOT_TOKEN` | ✅ | Bot token — injected into the container at deploy, never stored on the droplet |
| `FLAT_HUNTER_ALLOWED_USER_IDS` | ✅ | Comma-separated allowed Telegram ids — same injection |
| `FLAT_HUNTER_HTTP_PROXY_URL` | — | Outbound proxy for the scraper, if the droplet IP is blocked |

> The `FLAT_HUNTER_*` / `DO_FLAT_HUNTER_*` prefix namespaces these secrets so they
> don't collide with other projects' secrets on the same account. Inside the
> container the app still reads the plain env names (`TELEGRAM_BOT_TOKEN`, …) —
> the workflow maps the secrets onto them at deploy.

Set them all in one go with the helper (values stay on your machine — nothing is
printed or written to history):

```bash
brew install gh && gh auth login      # one time
./scripts/set-github-secrets.sh
```

Or add each manually in the GitHub UI (link above).

### Runtime mode & sources (repo Variables)

Non-secret runtime config is driven by GitHub **Variables** (Settings → Secrets
and variables → Actions → **Variables**), so you can change how prod runs without
editing code — just set the variable and re-deploy. Safe defaults ship in the
workflow:

| Variable | Default | Set it to… |
|---|---|---|
| `SOURCES` | `domria,rieltor` | which sites are active (comma-separated) |
| `POLL_INTERVAL_MS` | `600000` | raise/lower the poll interval (ms) |

DOM.RIA needs the `FLAT_HUNTER_DOMRIA_API_KEY` secret to return data.

### One-time droplet setup

```bash
# 1. On your machine: generate a dedicated deploy key (no passphrase)
ssh-keygen -t ed25519 -f ./flat_hunter_deploy -C "flat-hunter-ci" -N ""

# 2. Authorize its PUBLIC key on the droplet
ssh-copy-id -i ./flat_hunter_deploy.pub <user>@<droplet-host>
#   (or append flat_hunter_deploy.pub to ~/.ssh/authorized_keys manually)

# 3. Put the PRIVATE key into the DO_FLAT_HUNTER_SSH_PRIVATE_KEY secret
cat ./flat_hunter_deploy      # copy the whole output, incl. BEGIN/END lines

# 4. Ensure the droplet has Docker + the Compose v2 plugin. A non-root DO_FLAT_HUNTER_USER
#    must be able to run docker:  sudo usermod -aG docker <user>
#    (No .env to create — the app secrets above are injected by the deploy.)
```

Then push to `main` (or trigger **Actions → CI / Deploy → Run workflow**). Watch
it under the repo's **Actions** tab; the health-check step surfaces app logs if
the container fails to start (e.g. a bad `TELEGRAM_BOT_TOKEN`).

> **Note:** commit `package-lock.json` — `npm ci` (and its cache) require it.

---

## Configuration reference

See [`.env.example`](.env.example) for the annotated list. Highlights:

| Var | Default | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | **required** |
| `ALLOWED_USER_IDS` | — | comma-separated numeric ids; **empty = nobody** (fail-closed) |
| `REDIS_URL` | `redis://127.0.0.1:6379` | overridden to `redis://redis:6379` in Compose |
| `REDIS_KEY_PREFIX` | `olx` | namespaces every key |
| `POLL_INTERVAL_MS` | `300000` | base poll interval (5 min) |
| `POLL_JITTER_MS` | `60000` | ± random jitter per cycle |
| `SOURCES` | `domria,rieltor` | comma list of active sites (`olx,rieltor,domria,lun,flatfy,birdrent,josti`) |
| `DOMRIA_API_KEY` | — | DOM.RIA official API key; without it `domria` returns nothing |
| `DOMRIA_MAX_DETAILS` | `10` | cap on per-search DOM.RIA detail calls (rate-limit guard) |
| `OLX_BASE_URL` | `https://www.olx.ua` | OLX source only |
| `OLX_CATEGORY_PATH` | `uk/nedvizhimost/kvartiry` | OLX source only |
| `HTTP_PROXY_URL` | — | optional outbound proxy for all sources |
| `SCRAPER_TIMEOUT_MS` | `15000` | per-request timeout |
| `SCRAPER_MAX_RETRIES` | `3` | retry-with-backoff attempts |
| `LOG_LEVEL` | `log` | `error`\|`warn`\|`log`\|`debug`\|`verbose` |

---

## Scripts

```bash
npm run start:dev    # watch mode
npm run build        # compile to dist/
npm run start:prod   # run compiled build
npm test             # run the unit test suite
npm run test:cov     # tests + coverage (enforces an 80% threshold)
npm run lint         # eslint --fix
npm run format       # prettier
```

### Testing

Unit tests (Jest) cover the logic-heavy code — config parsing, the range/owner
parsers, the listing parsers + site specs, the scheduler diff/prime logic, the
Redis repositories (via `ioredis-mock`), the source registry, the notification
formatting, the `/newsearch` state machine and the command/action handlers.
External I/O (Redis, Telegram, axios) is mocked, so the suite is fast and
network-free. Coverage sits around **96% statements / 98% lines**, and
`npm run test:cov` fails under an 80% threshold — it also runs in CI on every
push/PR.

---

## Known limitations / next steps

- **Only DOM.RIA is wired to the wizard.** The other sources exist in the engine
  but their HTML parsers need tuning against the live sites and no wizard flow
  drives them yet. The `ListingSource` interface keeps adding them isolated.
- **DOM.RIA filtering** is city + price + area + rooms (Kyiv geo mapped; add
  more cities as needed). Raion-level filtering is a follow-up — RIA's district
  is a neighbourhood, not the admin raion the wizard offers.
- **No price *history***, by design — only current-vs-last-seen is compared. Full
  trend history is the trigger to add a time-series store (SQLite/Postgres) later.
- **Editing** a filter = re-run `/newsearch` (overwrites the site's filter);
  `/mysearches` also has Pause/Resume/Delete.
- **In-memory wizard session** — an interrupted `/newsearch` (e.g. bot restart
  mid-wizard) is simply restarted; saved profiles are unaffected (they're in Redis).
