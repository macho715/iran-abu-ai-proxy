param(
  [string]$RenderApiKey = "",
  [string]$RenderServiceName = "iran-abu-ai-proxy",
  [string]$GithubToken = "",
  [string]$DashUrl = "https://iran-abu-dash.vercel.app",
  [string]$ProxyEndpoint = "https://iran-abu-ai-proxy.onrender.com/api/ai/chat",
  [int]$WaitAfterDeploySeconds = 60,
  [switch]$PromptForMissing,
  [switch]$RunVerify
)

$ErrorActionPreference = "Stop"

function Read-SensitiveValue {
  param([string]$Prompt)
  $secure = Read-Host -AsSecureString -Prompt $Prompt
  return [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  )
}

function Test-ValidValue {
  param([string]$Value, [string]$Name)
  if ([string]::IsNullOrWhiteSpace($Value)) { throw "$Name is required." }
  if ($Value -match "[<>]") { throw "$Name contains placeholder characters (< or >)." }
  if ($Value -match "\s") { throw "$Name contains whitespace." }
  if ($Value -match "[^\x20-\x7E]") { throw "$Name contains non-ASCII characters." }
}

# ── Collect Render API key ─────────────────────────────────────────────────────
if (-not $RenderApiKey) {
  $RenderApiKey = $env:RENDER_API_KEY
}
if (-not $RenderApiKey) {
  if ($PromptForMissing) {
    $RenderApiKey = Read-SensitiveValue -Prompt "Enter Render API key (dashboard.render.com → Account Settings → API Keys)"
  } else {
    throw "RenderApiKey is required. Pass -RenderApiKey, set `$env:RENDER_API_KEY, or use -PromptForMissing."
  }
}
Test-ValidValue -Value $RenderApiKey -Name "RenderApiKey"

# ── Collect GitHub token ───────────────────────────────────────────────────────
if (-not $GithubToken) {
  $GithubToken = $env:MYAGENT_GITHUB_TOKEN
}
if (-not $GithubToken) {
  if ($PromptForMissing) {
    $GithubToken = Read-SensitiveValue -Prompt "Enter GitHub PAT with Copilot access (ghp_... or ghu_...)"
  } else {
    throw "GithubToken is required. Pass -GithubToken, set `$env:MYAGENT_GITHUB_TOKEN, or use -PromptForMissing."
  }
}
Test-ValidValue -Value $GithubToken -Name "GithubToken"
if ($GithubToken.Length -lt 10) { throw "GithubToken is too short." }

$renderHeaders = @{
  Authorization  = "Bearer $RenderApiKey"
  "Content-Type" = "application/json"
  Accept         = "application/json"
}

# ── Find Render service ID ─────────────────────────────────────────────────────
Write-Host "==> Finding Render service: $RenderServiceName"
$resp = Invoke-RestMethod `
  -Uri "https://api.render.com/v1/services?name=$([Uri]::EscapeDataString($RenderServiceName))&limit=10" `
  -Headers $renderHeaders `
  -Method GET

$serviceEntry = $resp | Where-Object { $_.service.name -eq $RenderServiceName } | Select-Object -First 1
if (-not $serviceEntry) {
  Write-Host "[INFO] Full response: $($resp | ConvertTo-Json -Depth 5)"
  throw "Service '$RenderServiceName' not found. Check -RenderServiceName."
}
$serviceId = $serviceEntry.service.id
Write-Host "[PASS] Found service id=$serviceId"

# ── Set MYAGENT_GITHUB_TOKEN via Render env-vars API ──────────────────────────
Write-Host "==> Setting MYAGENT_GITHUB_TOKEN on service $serviceId"
$envBody = @{
  envVars = @(
    @{ key = "MYAGENT_GITHUB_TOKEN"; value = $GithubToken }
  )
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Uri "https://api.render.com/v1/services/$serviceId/env-vars" `
  -Headers $renderHeaders `
  -Method PUT `
  -Body $envBody | Out-Null

Write-Host "[PASS] MYAGENT_GITHUB_TOKEN set on Render"

# ── Trigger a new deploy ───────────────────────────────────────────────────────
Write-Host "==> Triggering Render redeploy"
$deployBody = @{ clearCache = "do_not_clear" } | ConvertTo-Json
$deploy = Invoke-RestMethod `
  -Uri "https://api.render.com/v1/services/$serviceId/deploys" `
  -Headers $renderHeaders `
  -Method POST `
  -Body $deployBody

Write-Host "[INFO] Deploy id=$($deploy.id) status=$($deploy.status)"
Write-Host "[INFO] Waiting $WaitAfterDeploySeconds s for service to restart..."
Start-Sleep -Seconds $WaitAfterDeploySeconds

# ── Optional: verify health ────────────────────────────────────────────────────
$proxyBase = $ProxyEndpoint -replace "/api/ai/chat/?$", ""
Write-Host "==> GET $proxyBase/api/ai/health"
try {
  $health = Invoke-WebRequest -Uri "$proxyBase/api/ai/health" -UseBasicParsing -ErrorAction Stop
  if ([int]$health.StatusCode -eq 200) {
    Write-Host "[PASS] health 200"
  } else {
    Write-Host "[WARN] health returned $([int]$health.StatusCode)"
  }
} catch {
  Write-Host "[WARN] health check failed: $($_.Exception.Message)"
}

# ── Optional: full cutover verification ───────────────────────────────────────
if ($RunVerify) {
  Write-Host "==> Running verify-cutover.ps1"
  & "$PSScriptRoot\verify-cutover.ps1" `
    -ProxyUrl        $ProxyEndpoint `
    -TokenUrl        "$DashUrl/api/ai/token" `
    -Origin          $DashUrl `
    -ExpectedProxyEndpoint $ProxyEndpoint
  if ($LASTEXITCODE -ne 0) {
    throw "Cutover verification failed after Render env update."
  }
}

Write-Host "PASS: Render MYAGENT_GITHUB_TOKEN set and deploy triggered."
Write-Host "Run verify-cutover.ps1 (or pass -RunVerify) to confirm all checks pass."
