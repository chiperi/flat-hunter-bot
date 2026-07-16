# Security Policy

## Supported versions

This is a small personal project with a single active line of development. Only the latest `main`
is supported; fixes land there.

## Reporting a vulnerability

**Please do not report security issues in public GitHub issues or pull requests.**

Report privately via GitHub's **[Private vulnerability reporting](https://github.com/chiperi/flat-hunter-bot/security/advisories/new)**
(the repo's **Security** tab → **Report a vulnerability**). Include:

- a description of the issue and its impact,
- steps to reproduce (or a proof of concept),
- affected version / commit.

This is a best-effort, volunteer-maintained project — expect an acknowledgement within a few days,
but no formal SLA. Please give a reasonable window for a fix before any public disclosure.

## Scope & notes

- **Secrets** (Telegram token, `DOMRIA_API_KEY`, SSH deploy key, allowlist) are provided at runtime
  via GitHub Actions secrets and environment variables — they are **never** committed to the repo.
- The bot exposes **no inbound network surface** (long polling only, no open ports), which limits the
  attack surface considerably.
- It stores **no seller personal data** (only listing id / price / area / link) in Redis.
- Access is gated by a fail-closed allowlist (`ALLOWED_USER_IDS`); every profile-mutating action
  verifies ownership.

If you find committed secrets or a data-exposure issue, that qualifies as a security report — please
use the private channel above.
