# Cloudflare Kill Switch — interactive setup for Windows.
# Run from the project root: .\setup.ps1
#Requires -Version 5
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Helpers ────────────────────────────────────────────────────────────────────
function Write-Ok      ($m) { Write-Host "  $([char]0x2713) $m" -ForegroundColor Green }
function Write-Info    ($m) { Write-Host "  $([char]0x25B8) $m" -ForegroundColor Cyan }
function Write-Section ($m) { Write-Host "`n  -- $m" -ForegroundColor White; Write-Host "" }
function Write-Ask     ($m) { Write-Host "  ? $m" -ForegroundColor Yellow }
function Fail          ($m) { Write-Host "  x $m" -ForegroundColor Red; exit 1 }

function Read-Value {
  param([switch]$Secret)
  Write-Host "  > " -NoNewline -ForegroundColor Yellow
  if ($Secret) {
    $ss  = Read-Host -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
    try   { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  }
  return Read-Host
}

function Ask-YesNo {
  param([string]$Prompt, [bool]$Default = $true)
  $hint = if ($Default) { '[Y/n]' } else { '[y/N]' }
  Write-Ask "$Prompt $hint"
  $ans = Read-Value
  if ($ans -eq '') { return $Default }
  return $ans -match '^[Yy]'
}

function New-RandomHex {
  $bytes = [byte[]]::new(32)
  $rng   = [Security.Cryptography.RNGCryptoServiceProvider]::new()
  $rng.GetBytes($bytes)
  return ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
}

# ── Banner ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Cloudflare Kill Switch -- Setup" -ForegroundColor White
Write-Host "  ---------------------------------" -ForegroundColor DarkGray

# ── Prerequisites ──────────────────────────────────────────────────────────────
Write-Section "Checking prerequisites"

if (-not (Get-Command node  -ErrorAction SilentlyContinue)) { Fail "Node.js not found -- install from https://nodejs.org" }
if (-not (Get-Command pnpm  -ErrorAction SilentlyContinue)) { Fail "pnpm not found -- run: npm install -g pnpm" }
Write-Ok "Node.js and pnpm found"

$whoami = pnpm exec wrangler whoami 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "`n  Wrangler is not authenticated. Opening browser login...`n" -ForegroundColor Yellow
  pnpm exec wrangler login
}
Write-Ok "Wrangler authenticated"

# ── Dependencies ───────────────────────────────────────────────────────────────
Write-Info "Installing dependencies..."
pnpm install
Write-Ok "Dependencies installed"

# ── KV namespace ───────────────────────────────────────────────────────────────
Write-Info "Creating KV namespace..."
$kvRaw   = (pnpm exec wrangler kv namespace create KILL_SWITCH_STATE 2>&1) | Out-String
$kvMatch = [regex]::Match($kvRaw, 'id = "([^"]+)"')
$kvId    = if ($kvMatch.Success) { $kvMatch.Groups[1].Value } else { '' }

if (-not $kvId -and $kvRaw -match 'already exists') {
  Write-Info "Namespace already exists, looking up existing ID..."
  $listRaw   = (pnpm exec wrangler kv namespace list 2>&1) | Out-String
  $jsonMatch = [regex]::Match($listRaw, '\[[\s\S]*\]')
  if ($jsonMatch.Success) {
    try {
      $ns    = $jsonMatch.Value | ConvertFrom-Json
      $kvId  = ($ns | Where-Object { $_.title -eq 'KILL_SWITCH_STATE' } | Select-Object -First 1).id
    } catch { }
  }
}

if (-not $kvId) {
  Write-Host "`n  Wrangler output:`n$kvRaw" -ForegroundColor Yellow
  Write-Ask "Could not parse KV namespace ID -- paste it manually:"
  $kvId = Read-Value
  if (-not $kvId) { Fail "KV namespace ID is required" }
}
Write-Ok "KV namespace: $kvId"

# ── Required ───────────────────────────────────────────────────────────────────
Write-Section "Required configuration"

Write-Host "  zone    -> protect a single zone, works on the free plan  [default]"
Write-Host "  account -> protect all zones, requires an Enterprise plan"
Write-Host "  none    -> no WAF rule; for accounts without a domain (workers.dev / pages.dev only)`n"
Write-Ask "WAF scope [zone/account/none]"
$scope = Read-Value
if (-not $scope) { $scope = 'zone' }
if ($scope -notin @('zone', 'account', 'none')) { Fail "Scope must be 'zone', 'account' or 'none'" }

Write-Host ""
Write-Ask "Cloudflare Account ID"
Write-Host "    https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/" -ForegroundColor DarkGray
$accountId = Read-Value
if (-not $accountId) { Fail "Account ID is required" }

$zoneId = ''
if ($scope -eq 'zone') {
  Write-Host ""
  Write-Ask "Cloudflare Zone ID"
  Write-Host "    https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/" -ForegroundColor DarkGray
  $zoneId = Read-Value
  if (-not $zoneId) { Fail "Zone ID is required when scope is 'zone'" }
}

$tokenPerms = switch ($scope) {
  'zone'    { 'Zone -> WAF -> Edit' }
  'account' { 'Account -> Account WAF -> Edit' }
  'none'    { 'Workers Scripts / Cloudflare Pages -> Edit, depending on the blocking choices below' }
}
Write-Host ""
Write-Ask "Cloudflare API Token  (needs $tokenPerms)"
Write-Host "    Create at: dash.cloudflare.com/profile/api-tokens" -ForegroundColor DarkGray
$apiToken = Read-Value -Secret
if (-not $apiToken) { Fail "API Token is required" }

# ── Recovery webhook ────────────────────────────────────────────────────────────
Write-Section "Recovery webhook (optional)"
Write-Host "  Lets you restore traffic via POST /restore without touching the dashboard.`n"

$enableWebhook  = Ask-YesNo "Enable recovery webhook?" -Default $true
$recoverySecret = ''
if ($enableWebhook) {
  Write-Host ""
  Write-Ask "Recovery secret (press Enter to generate one automatically)"
  $recoverySecret = Read-Value -Secret
  if (-not $recoverySecret) {
    $recoverySecret = New-RandomHex
    Write-Ok "Recovery secret generated"
  }
}

# ── Email alerts ────────────────────────────────────────────────────────────────
Write-Section "Email alerts (optional)"
Write-Host "  Requires Cloudflare Email Routing with a verified destination address.`n"

$enableEmail = Ask-YesNo "Enable email alerts?" -Default $false
$emailFrom = ''; $emailTo = ''
if ($enableEmail) {
  Write-Host ""
  Write-Ask "Sender address  (e.g. killswitch@yourdomain.com)"
  $emailFrom = Read-Value
  Write-Host ""
  Write-Ask "Destination address  (must be verified in Email Routing)"
  $emailTo = Read-Value
}

# ── Workers / Pages blocking ────────────────────────────────────────────────────
Write-Section "Workers and Pages blocking (optional)"
Write-Host "  WAF rules block traffic on your custom domain, but NOT on .workers.dev"
Write-Host "  or .pages.dev subdomains. Configure these to also shut those down.`n"

if ($scope -eq 'none') {
  Write-Host "  NOTE: with scope 'none' this is the ONLY protection the kill switch has." -ForegroundColor Yellow
  Write-Host "  Choose 'all' below unless you have a reason not to.`n" -ForegroundColor Yellow
}

$blockWorkersChoice = 'none'
Write-Ask "Disable workers.dev subdomains on kill?"
Write-Host "    [n]one (default) | [a]ll discovered scripts | [l]ist specific names" -ForegroundColor DarkGray
$choice = Read-Value
if ($choice -match '^[Aa]') { $blockWorkersChoice = 'all' }
elseif ($choice -match '^[Ll]') { $blockWorkersChoice = 'list' }

$blockWorkersList = @()
if ($blockWorkersChoice -eq 'list') {
  Write-Host ""
  Write-Ask "Comma-separated Workers script names (e.g. my-api,my-auth)"
  $raw = Read-Value
  if ($raw) { $blockWorkersList = $raw -split '\s*,\s*' | Where-Object { $_ } }
}

Write-Host ""
Write-Ask "Block Pages projects on kill?"
Write-Host "    [n]one (default) | [a]ll discovered projects | [l]ist specific names" -ForegroundColor DarkGray
$pagesChoice = Read-Value
$blockPagesChoice = 'none'
if ($pagesChoice -match '^[Aa]') { $blockPagesChoice = 'all' }
elseif ($pagesChoice -match '^[Ll]') { $blockPagesChoice = 'list' }

$blockPagesList = @()
if ($blockPagesChoice -eq 'list') {
  Write-Host ""
  Write-Ask "Comma-separated Pages project names (e.g. my-site,my-app)"
  $pagesRaw = Read-Value
  if ($pagesRaw) { $blockPagesList = $pagesRaw -split '\s*,\s*' | Where-Object { $_ } }
}

# ── Billing cycle ─────────────────────────────────────────────────────────────
Write-Section "Billing cycle"
Write-Host "  Cloudflare bills from the day your account was created, not the 1st."
Write-Host "  This day anchors the auto-reset below and the per-cycle usage windows"
Write-Host "  (R2 operations, and the KV/R2/D1 storage ceilings)."
Write-Host "  Find it at: dash.cloudflare.com -> Manage Account -> Billing"
Write-Host "  Enter 1 for plain calendar months.`n"

$billingDay = 0
while ($billingDay -lt 1 -or $billingDay -gt 31) {
  Write-Ask "Billing cycle start day (1-31) [1]"
  $raw = Read-Value
  if (-not $raw) { $raw = '1' }
  if (-not [int]::TryParse($raw, [ref]$billingDay)) { $billingDay = 0 }
  if ($billingDay -lt 1 -or $billingDay -gt 31) {
    Write-Host "  Enter a whole number between 1 and 31." -ForegroundColor Yellow
  }
}
if ($billingDay -gt 28) {
  Write-Info "Months shorter than $billingDay use their last day instead."
}

# ── Auto-reset ────────────────────────────────────────────────────────────────
Write-Section "Billing-cycle auto-reset (optional)"
Write-Host "  Automatically lifts the block on the first check on or after day"
Write-Host "  $billingDay of each month, once the quota that triggered it has reset.`n"
$autoReset = Ask-YesNo "Enable auto-reset?" -Default $true

# ── Apply ───────────────────────────────────────────────────────────────────────
Write-Section "Applying configuration"

Write-Info "Creating wrangler.toml from template..."
Copy-Item wrangler.toml.example wrangler.toml -Force
$toml = Get-Content wrangler.toml -Raw

$toml = $toml.Replace('REPLACE_ME_WITH_YOUR_KV_NAMESPACE_ID', $kvId)
$toml = $toml.Replace('REPLACE_ME_WITH_YOUR_ACCOUNT_ID',      $accountId)
$toml = $toml.Replace('REPLACE_ME_WITH_YOUR_ZONE_ID',         $zoneId)

if ($enableEmail) {
  $toml = [regex]::Replace($toml, '(?m)^# (\[\[send_email\]\])$',   '$1')
  $toml = [regex]::Replace($toml, '(?m)^# (name = "SEND_EMAIL")$',  '$1')
  $toml = $toml.Replace('# destination_address = "REPLACE_ME_WITH_DESTINATION_EMAIL"',
                         "destination_address = `"$emailTo`"")
  $toml = [regex]::Replace($toml, '(CLOUDFLARE_ZONE_ID\s*=\s*"[^"]*")',
                            "`$1`nEMAIL_FROM = `"$emailFrom`"`nEMAIL_TO   = `"$emailTo`"")
}

[System.IO.File]::WriteAllText("$PWD\wrangler.toml", $toml)
Write-Ok "wrangler.toml updated"

Write-Info "Updating src/config.ts..."
$cfg = Get-Content src/config.ts -Raw

# Regex anchors (not literal defaults) so the script also works on a config.ts
# that was previously customised by hand or by an earlier setup run.
$cfg = [regex]::Replace($cfg, "scope: '(?:zone|account|none)'", "scope: '$scope'")
$cfg = [regex]::Replace($cfg, 'autoResetOnBillingCycle: (?:true|false)',
                        "autoResetOnBillingCycle: $($autoReset.ToString().ToLower())")
$cfg = [regex]::Replace($cfg, 'billingCycleDay: \d+', "billingCycleDay: $billingDay")
$cfg = [regex]::Replace($cfg, 'enableRecoveryWebhook: (?:true|false)',
                        "enableRecoveryWebhook: $($enableWebhook.ToString().ToLower())")

# Matches "workers: 'all'," / "workers: [...]," with or without an `as` cast.
$workersPattern = "workers: (?:'all'(?: as 'all' \| string\[\])?|\[[^\]]*\](?: as string\[\])?),"
$pagesPattern   = "pages: (?:'all'(?: as 'all' \| string\[\])?|\[[^\]]*\](?: as string\[\])?),"

$workersValue = switch ($blockWorkersChoice) {
  'all'  { "'all'" }
  'list' { '[' + (($blockWorkersList | ForEach-Object { "'$_'" }) -join ', ') + ']' }
  default { '[]' }
}
$pagesValue = switch ($blockPagesChoice) {
  'all'  { "'all'" }
  'list' { '[' + (($blockPagesList | ForEach-Object { "'$_'" }) -join ', ') + ']' }
  default { '[]' }
}
$cfg = [regex]::Replace($cfg, $workersPattern, "workers: $workersValue,")
$cfg = [regex]::Replace($cfg, $pagesPattern,   "pages: $pagesValue,")

[System.IO.File]::WriteAllText("$PWD\src\config.ts", $cfg)
Write-Ok "src/config.ts updated"

Write-Info "Setting CLOUDFLARE_API_TOKEN secret..."
$apiToken | pnpm exec wrangler secret put CLOUDFLARE_API_TOKEN
Write-Ok "API token set"

if ($enableWebhook) {
  Write-Info "Setting RECOVERY_SECRET..."
  $recoverySecret | pnpm exec wrangler secret put RECOVERY_SECRET
  Write-Ok "Recovery secret set"
}

# ── Deploy ──────────────────────────────────────────────────────────────────────
Write-Host ""
if (Ask-YesNo "Deploy now?" -Default $true) {
  Write-Info "Validating configuration and deploying..."
  pnpm run deploy
  if ($LASTEXITCODE -ne 0) { Fail "Deploy aborted — fix the issues reported above and run 'pnpm run deploy'" }
  Write-Ok "Deployed!"
}

# ── Summary ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Setup complete" -ForegroundColor Green
Write-Host ""
if ($enableWebhook -and $recoverySecret) {
  Write-Host "  Recovery secret: $recoverySecret" -ForegroundColor Cyan
  Write-Host "  Save this -- you will need it to call POST /restore" -ForegroundColor DarkGray
  Write-Host ""
}
