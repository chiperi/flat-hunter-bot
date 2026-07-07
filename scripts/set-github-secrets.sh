#!/usr/bin/env bash
#
# Set the GitHub Actions secrets this repo's deploy needs — interactively and
# safely. Values are read locally (hidden where sensitive), encrypted by the
# GitHub CLI, and never written to disk or shell history by this script.
#
# Prereqs (one time):
#   brew install gh          # or see https://cli.github.com
#   gh auth login            # log in to the account that owns the repo
#
# Usage:
#   ./scripts/set-github-secrets.sh
#
# Re-run any time to rotate a value (gh overwrites existing secrets).

set -euo pipefail

REPO="${REPO:-chiperi/flat-hunter-bot}"

if ! command -v gh >/dev/null 2>&1; then
  echo "❌ GitHub CLI 'gh' not found." >&2
  echo "   Install:  brew install gh   then:  gh auth login" >&2
  echo "   (Or set these secrets manually: GitHub → Settings → Secrets and variables → Actions)" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "❌ Not logged in to gh. Run:  gh auth login" >&2
  exit 1
fi

echo "Setting secrets on: $REPO"
echo "(press Enter to SKIP an optional secret and leave it unchanged)"
echo

# set_secret <NAME> <PROMPT> <mode: text|hidden|file> <required: yes|no>
set_secret() {
  local name="$1" prompt="$2" mode="$3" required="$4" val="" path=""

  case "$mode" in
    hidden)
      read -rsp "  $prompt: " val; echo
      ;;
    file)
      read -rp "  $prompt (path to file): " path
      if [ -n "$path" ]; then
        path="${path/#\~/$HOME}"
        [ -f "$path" ] || { echo "  ⚠️  file not found: $path — skipping $name"; return; }
      fi
      ;;
    *)
      read -rp "  $prompt: " val
      ;;
  esac

  # Skip on empty input.
  if [ "$mode" = "file" ]; then
    [ -n "$path" ] || { [ "$required" = yes ] && echo "  ⚠️  $name is required but was skipped"; return; }
    gh secret set "$name" --repo "$REPO" < "$path"
  else
    [ -n "$val" ] || { [ "$required" = yes ] && echo "  ⚠️  $name is required but was skipped"; return; }
    printf '%s' "$val" | gh secret set "$name" --repo "$REPO"
  fi
  echo "  ✅ $name set"
}

echo "── SSH / droplet ──────────────────────────────────────────────"
set_secret DO_FLAT_HUNTER_HOST            "Droplet IP or hostname"                       text   yes
set_secret DO_FLAT_HUNTER_USER            "SSH user (e.g. root or a docker-group user)"  text   yes
set_secret DO_FLAT_HUNTER_SSH_PRIVATE_KEY "Deploy PRIVATE key"                           file   yes
set_secret DO_FLAT_HUNTER_SSH_PORT        "SSH port (blank = 22)"                        text   no

echo
echo "── App secrets ────────────────────────────────────────────────"
set_secret FLAT_HUNTER_TELEGRAM_BOT_TOKEN "Telegram bot token (from @BotFather)"         hidden yes
set_secret FLAT_HUNTER_ALLOWED_USER_IDS   "Allowed Telegram user IDs, comma-separated"   text   yes
set_secret FLAT_HUNTER_HTTP_PROXY_URL     "Scraper proxy URL (blank = none)"             hidden no

echo
echo "Done. Verify at: https://github.com/$REPO/settings/secrets/actions"
echo "Then trigger a deploy:  git push origin main   (or Actions → Run workflow)"
