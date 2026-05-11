#!/usr/bin/env bash
# Cloudflare Kill Switch — interactive setup for macOS and Linux.
# Run from the project root: bash setup.sh
set -euo pipefail

# ── Helpers ────────────────────────────────────────────────────────────────────
G='\033[0;32m' Y='\033[1;33m' R='\033[0;31m' C='\033[0;36m' B='\033[1m' N='\033[0m'
ok()      { printf "${G}  ✓${N} %s\n" "$*"; }
info()    { printf "${C}  ▸${N} %s\n" "$*"; }
die()     { printf "${R}  ✗${N} %s\n" "$*" >&2; exit 1; }
section() { printf "\n${B}  ── %s ──────────────────────────────────${N}\n\n" "$*"; }
ask()     { printf "${Y}  ?${N} %s\n  ${Y}▶${N} " "$*"; }

yn() {
  # yn "Prompt" default(Y|N) → returns 0 for yes, 1 for no
  local prompt=$1 default=${2:-Y}
  ask "$prompt [${default}]"
  read -r _ans; _ans=${_ans:-$default}
  [[ "$_ans" =~ ^[Yy] ]]
}

# ── Banner ─────────────────────────────────────────────────────────────────────
printf "\n${B}  Cloudflare Kill Switch — Setup${N}\n"
printf "  ─────────────────────────────────\n"

# ── Prerequisites ──────────────────────────────────────────────────────────────
section "Checking prerequisites"
command -v node    >/dev/null 2>&1 || die "Node.js not found — install from https://nodejs.org"
command -v pnpm    >/dev/null 2>&1 || die "pnpm not found — run: npm install -g pnpm"
command -v python3 >/dev/null 2>&1 || die "python3 not found — required for config file updates"
ok "Node.js, pnpm and python3 found"

if ! pnpm exec wrangler whoami >/dev/null 2>&1; then
  printf "\n  ${Y}Wrangler is not authenticated.${N} Opening browser login...\n\n"
  pnpm exec wrangler login
fi
ok "Wrangler authenticated"

# ── Dependencies ───────────────────────────────────────────────────────────────
info "Installing dependencies..."
pnpm install
ok "Dependencies installed"

# ── KV namespace ───────────────────────────────────────────────────────────────
info "Creating KV namespace..."
KV_RAW=$(pnpm exec wrangler kv namespace create KILL_SWITCH_STATE 2>&1) || true
KV_ID=$(printf '%s' "$KV_RAW" | python3 -c "
import sys, re
m = re.search(r'id = \"([^\"]+)\"', sys.stdin.read())
print(m.group(1) if m else '')
")

if [ -z "$KV_ID" ] && printf '%s' "$KV_RAW" | grep -q 'already exists'; then
  info "Namespace already exists, looking up existing ID..."
  KV_LIST=$(pnpm exec wrangler kv namespace list 2>&1) || true
  KV_ID=$(printf '%s' "$KV_LIST" | python3 -c "
import sys, json, re
text = sys.stdin.read()
m = re.search(r'\[.*\]', text, re.DOTALL)
if m:
    try:
        ns = json.loads(m.group(0))
        hit = next((n for n in ns if n.get('title') == 'KILL_SWITCH_STATE'), None)
        if hit: print(hit['id'])
    except: pass
")
fi

if [ -z "$KV_ID" ]; then
  printf "\n  Wrangler output:\n%s\n\n" "$KV_RAW"
  ask "Could not parse KV namespace ID — paste it manually:"
  read -r KV_ID
  [ -z "$KV_ID" ] && die "KV namespace ID is required"
fi
ok "KV namespace: $KV_ID"

# ── Required ───────────────────────────────────────────────────────────────────
section "Required configuration"

printf "  zone    → protect a single zone, works on the free plan  [default]\n"
printf "  account → protect all zones, requires a paid Cloudflare plan\n\n"
ask "WAF scope [zone/account]"
read -r SCOPE; SCOPE=${SCOPE:-zone}
[[ "$SCOPE" == "zone" || "$SCOPE" == "account" ]] || die "Scope must be 'zone' or 'account'"

printf "\n"
ask "Cloudflare Account ID\n     https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/"
read -r ACCOUNT_ID
[ -z "$ACCOUNT_ID" ] && die "Account ID is required"

ZONE_ID=""
if [ "$SCOPE" = "zone" ]; then
  printf "\n"
  ask "Cloudflare Zone ID\n     https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/"
  read -r ZONE_ID
  [ -z "$ZONE_ID" ] && die "Zone ID is required when scope is 'zone'"
fi

if [ "$SCOPE" = "zone" ]; then TOKEN_PERMS="Zone → WAF → Edit"
else TOKEN_PERMS="Account → Account WAF → Edit"; fi
printf "\n"
ask "Cloudflare API Token  (needs $TOKEN_PERMS)\n     Create at: dash.cloudflare.com/profile/api-tokens"
read -rs API_TOKEN; printf "\n"
[ -z "$API_TOKEN" ] && die "API Token is required"

# ── Recovery webhook ────────────────────────────────────────────────────────────
section "Recovery webhook (optional)"
printf "  Lets you restore traffic via POST /restore without touching the dashboard.\n\n"

ENABLE_WEBHOOK=false; RECOVERY_SECRET=""
if yn "Enable recovery webhook?" Y; then
  ENABLE_WEBHOOK=true
  printf "\n"
  ask "Recovery secret (press Enter to generate one automatically)"
  read -rs RECOVERY_SECRET; printf "\n"
  if [ -z "$RECOVERY_SECRET" ]; then
    RECOVERY_SECRET=$(openssl rand -hex 32)
    ok "Recovery secret generated"
  fi
fi

# ── Email alerts ────────────────────────────────────────────────────────────────
section "Email alerts (optional)"
printf "  Requires Cloudflare Email Routing with a verified destination address.\n\n"

ENABLE_EMAIL=false; EMAIL_FROM=""; EMAIL_TO=""
if yn "Enable email alerts?" N; then
  ENABLE_EMAIL=true
  printf "\n"
  ask "Sender address  (e.g. killswitch@yourdomain.com)"
  read -r EMAIL_FROM
  printf "\n"
  ask "Destination address  (must be verified in Email Routing)"
  read -r EMAIL_TO
fi

# ── Workers / Pages blocking ────────────────────────────────────────────────────
section "Workers and Pages blocking (optional)"
printf "  WAF rules block traffic on your custom domain, but NOT on .workers.dev\n"
printf "  or .pages.dev subdomains. Configure these to also shut those down.\n\n"

BLOCK_WORKERS_CHOICE="none"
ask "Disable workers.dev subdomains on kill?\n     [n]one (default) | [a]ll discovered scripts | [l]ist specific names"
read -r CHOICE
case "$CHOICE" in
  [Aa]*) BLOCK_WORKERS_CHOICE="all" ;;
  [Ll]*) BLOCK_WORKERS_CHOICE="list" ;;
esac

BLOCK_WORKERS_LIST=""
if [ "$BLOCK_WORKERS_CHOICE" = "list" ]; then
  printf "\n"
  ask "Comma-separated Workers script names (e.g. my-api,my-auth)"
  read -r BLOCK_WORKERS_LIST
fi

printf "\n"
ask "Block Pages projects on kill?\n     [n]one (default) | [a]ll discovered projects | [l]ist specific names"
read -r PAGES_CHOICE
BLOCK_PAGES_CHOICE="none"
case "${PAGES_CHOICE:-n}" in
  [Aa]*) BLOCK_PAGES_CHOICE="all" ;;
  [Ll]*) BLOCK_PAGES_CHOICE="list" ;;
esac

BLOCK_PAGES_LIST=""
if [ "$BLOCK_PAGES_CHOICE" = "list" ]; then
  printf "\n"
  ask "Comma-separated Pages project names (e.g. my-site,my-app)"
  read -r BLOCK_PAGES_LIST
fi

# ── Auto-reset ──────────────────────────────────────────────────────────────────
section "Monthly auto-reset (optional)"
printf "  Automatically lifts the block on the 1st of each month,\n"
printf "  aligned with Cloudflare's billing reset.\n\n"

AUTO_RESET=true
yn "Enable auto-reset?" Y || AUTO_RESET=false

# ── Apply ───────────────────────────────────────────────────────────────────────
section "Applying configuration"

info "Creating wrangler.toml from template..."
cp wrangler.toml.example wrangler.toml
info "Applying configuration..."
KV_ID="$KV_ID" \
ACCOUNT_ID="$ACCOUNT_ID" \
ZONE_ID="$ZONE_ID" \
EMAIL_FROM="$EMAIL_FROM" \
EMAIL_TO="$EMAIL_TO" \
ENABLE_EMAIL="$ENABLE_EMAIL" \
SCOPE="$SCOPE" \
AUTO_RESET="$AUTO_RESET" \
ENABLE_WEBHOOK="$ENABLE_WEBHOOK" \
BLOCK_WORKERS_CHOICE="$BLOCK_WORKERS_CHOICE" \
BLOCK_WORKERS_LIST="$BLOCK_WORKERS_LIST" \
BLOCK_PAGES_CHOICE="$BLOCK_PAGES_CHOICE" \
BLOCK_PAGES_LIST="$BLOCK_PAGES_LIST" \
python3 << 'PY'
import os, re

kv_id          = os.environ['KV_ID']
account_id     = os.environ['ACCOUNT_ID']
zone_id        = os.environ['ZONE_ID']
email_from     = os.environ['EMAIL_FROM']
email_to       = os.environ['EMAIL_TO']
enable_email   = os.environ['ENABLE_EMAIL']   == 'true'
scope          = os.environ['SCOPE']
auto_reset     = os.environ['AUTO_RESET']     # 'true' | 'false'
enable_webhook = os.environ['ENABLE_WEBHOOK'] # 'true' | 'false'

# wrangler.toml
with open('wrangler.toml') as f:
    t = f.read()

t = t.replace('REPLACE_ME_WITH_YOUR_KV_NAMESPACE_ID', kv_id)
t = t.replace('REPLACE_ME_WITH_YOUR_ACCOUNT_ID',      account_id)
t = t.replace('REPLACE_ME_WITH_YOUR_ZONE_ID',         zone_id)

if enable_email:
    t = re.sub(r'^# (\[\[send_email\]\])$',      r'\1',                  t, flags=re.MULTILINE)
    t = re.sub(r'^# (name = "SEND_EMAIL")$',      r'\1',                  t, flags=re.MULTILINE)
    t = t.replace('# destination_address = "REPLACE_ME_WITH_DESTINATION_EMAIL"',
                  f'destination_address = "{email_to}"')
    t = re.sub(r'(CLOUDFLARE_ZONE_ID\s*=\s*"[^"]*")',
               f'\\1\nEMAIL_FROM = "{email_from}"\nEMAIL_TO   = "{email_to}"', t)

with open('wrangler.toml', 'w') as f:
    f.write(t)

# src/config.ts
with open('src/config.ts') as f:
    c = f.read()

c = c.replace("scope: 'zone'",              f"scope: '{scope}'")
c = c.replace('autoResetOnFirstOfMonth: true',  f'autoResetOnFirstOfMonth: {auto_reset}')
c = c.replace('enableRecoveryWebhook: true',    f'enableRecoveryWebhook: {enable_webhook}')

block_workers_choice = os.environ.get('BLOCK_WORKERS_CHOICE', 'none')
block_workers_list   = [s for s in (os.environ.get('BLOCK_WORKERS_LIST', '') or '').split(',') if s.strip()]
block_pages_list     = [s for s in (os.environ.get('BLOCK_PAGES_LIST',   '') or '').split(',') if s.strip()]

if block_workers_choice == 'all':
    c = c.replace('workers: [] as string[],', "workers: 'all' as 'all' | string[],")
elif block_workers_choice == 'list' and block_workers_list:
    quoted = ', '.join(f"'{s.strip()}'" for s in block_workers_list)
    c = c.replace('workers: [] as string[],', f'workers: [{quoted}] as string[],')

block_pages_choice = os.environ.get('BLOCK_PAGES_CHOICE', 'none')
if block_pages_choice == 'all':
    c = c.replace('pages: [] as string[],', "pages: 'all' as 'all' | string[],")
elif block_pages_choice == 'list' and block_pages_list:
    quoted = ', '.join(f"'{s.strip()}'" for s in block_pages_list)
    c = c.replace('pages: [] as string[],', f'pages: [{quoted}] as string[],')
else:
    pass

with open('src/config.ts', 'w') as f:
    f.write(c)
PY
ok "Configuration files updated"

info "Setting CLOUDFLARE_API_TOKEN secret..."
printf '%s' "$API_TOKEN" | pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN
ok "API token set"

if [ "$ENABLE_WEBHOOK" = true ]; then
  info "Setting RECOVERY_SECRET..."
  printf '%s' "$RECOVERY_SECRET" | pnpm exec wrangler secret put RECOVERY_SECRET
  ok "Recovery secret set"
fi

# ── Deploy ──────────────────────────────────────────────────────────────────────
printf "\n"
if yn "Deploy now?" Y; then
  info "Deploying..."
  pnpm exec wrangler deploy
  ok "Deployed!"
fi

# ── Summary ─────────────────────────────────────────────────────────────────────
printf "\n${G}${B}  ✓ Setup complete${N}\n\n"
if [ "$ENABLE_WEBHOOK" = true ] && [ -n "$RECOVERY_SECRET" ]; then
  printf "  Recovery secret: ${B}%s${N}\n" "$RECOVERY_SECRET"
  printf "  ${C}Save this — you'll need it to call POST /restore${N}\n\n"
fi
