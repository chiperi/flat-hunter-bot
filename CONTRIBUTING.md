# Contributing to Flat Hunter Bot

Thanks for your interest! This is a small, personal project — contributions are welcome, but please
keep the [responsible-use disclaimer](README.md) in mind (it reads third-party listing sites).

## Getting started

**Prerequisites:** Node.js ≥ 20, a running Redis, a Telegram bot token (from
[@BotFather](https://t.me/BotFather)), and your numeric Telegram id (from
[@userinfobot](https://t.me/userinfobot)).

```bash
npm install
cp .env.example .env          # set TELEGRAM_BOT_TOKEN + ALLOWED_USER_IDS (at minimum)
docker run -p 6379:6379 redis:7-alpine   # or any local Redis
npm run start:dev             # watch mode
```

Set `DOMRIA_API_KEY` (from [developers.ria.com](https://developers.ria.com)) for real DOM.RIA data;
without it, only Rieltor runs. Never commit real secrets — `.env` is git-ignored; the deployed bot
gets its secrets from GitHub Actions secrets, not from any file in the repo.

## Development

| Task | Command |
|---|---|
| Build (typecheck) | `npm run build` |
| Run all tests | `npm test` |
| Coverage | `npm run test:cov` (gate: **80/80/80/70** stmt/branch/func/line — CI fails below) |
| Lint / format | `npm run lint` · `npm run format` |

- **TypeScript, NestJS conventions.** Match the surrounding style; Prettier + ESLint are configured.
- **Tests are required** for behavior changes — the CI coverage gate is enforced on every push/PR.
  The riskiest code (scheduler, source parsers, matching) is the best-tested; keep it that way.
- **Architecture** is documented in [`specifications/`](specifications/) — the constitution (invariant
  principles), the ADRs (why key decisions were made), the reverse-engineered spec of the current
  system, and domain notes. Read those before a non-trivial change.

## Adding a listing source

Sources live behind the `ListingSource` / `SiteSpec` abstraction (`src/sources/`):

1. Add a `SiteSpec` in `src/sources/site-specs.ts` (declarative `buildUrl`+`parse`, or an imperative
   `fetch` for multi-step APIs like DOM.RIA).
2. Register its id in `KNOWN_SOURCE_IDS` / `SOURCE_LABELS` (`src/sources/listing.interface.ts`).
3. Normalize prices to **UAH** (never mislabel a foreign currency; exclude no-price listings).
4. Return `[]` on any failure — a source must never throw into the polling loop.
5. Add a spec with fixtures (including a non-UAH price if the site sells in $/€).

Note: some sites (OLX, lun, flatfy) Cloudflare-block datacenter IPs and need a residential proxy
(`HTTP_PROXY_URL`) — see [ADR-0003](specifications/architecture/decisions/0003-sources-landscape.md).

## Pull requests

- Branch off `main`; keep PRs focused (one concern per PR).
- Commit messages use a conventional prefix: `feat:` / `fix:` / `chore:` / `docs:` / `perf:` /
  `refactor:`, with a short imperative summary.
- Ensure `npm run build` and `npm test` pass (coverage gate green) before opening the PR.
- PRs are squash-merged. Deployment to the droplet happens automatically from a green `main`.

## Bug reports & ideas

Open a GitHub issue with steps to reproduce (and the source id / a listing example where relevant).
For **security** issues, do **not** open a public issue — see [SECURITY.md](SECURITY.md).
