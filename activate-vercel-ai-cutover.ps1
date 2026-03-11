param(
  [string]$ProjectPath = "",
  [string]$DashUrl = "https://iran-abu-dash.vercel.app",
  [string]$ProxyEndpoint = "https://iran-abu-ai-proxy.onrender.com/api/ai/chat",
  [string]$VercelToken = "",
  [string]$SecretA = "",
  [int]$AiProxyTtlSeconds = 300,
  [string]$Issuer = "iran-abu-dash",
  [string]$Audience = "myagent-copilot-standalone",
  [switch]$PromptForMissing,
  [switch]$RunSmoke,
  [string]$SmokeQuestion = "Summarize 3 missing signals and 3 conflicting signals in Korean."
)

$ErrorActionPreference = "Stop"

function Test-ValidValue {
  param([string]$Value, [string]$Name)
  if ($null -eq $Value) {
    throw "$Name is required."
  }
  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "$Name is required."
  }
  if ($Value -match "[<>]") {
    throw "$Name contains invalid placeholder characters: < or >"
  }
  if ($Value -match "\s") {
    throw "$Name contains whitespace. Enter a plain token/string without spaces or newlines."
  }
  if ($Value -match "[^\x20-\x7E]") {
    throw "$Name contains non-ASCII characters. Did you paste placeholder text (예: '여기에_실제...')?"
  }
}

function Test-ValueShape {
  param(
    [string]$Value,
    [string]$Name,
    [int]$MinLength = 16,
    [string]$Pattern = "^[A-Za-z0-9._-]+$"
  )

  Test-ValidValue -Value $Value -Name $Name
  if ($Value.Length -lt $MinLength) {
    throw "$Name length is too short."
  }
  if ($Value -notmatch $Pattern) {
    throw "$Name contains unexpected characters. Allowed pattern: $Pattern"
  }
}

function Read-SensitiveValue {
  param([string]$Prompt)
  $secure = Read-Host -AsSecureString -Prompt $Prompt
  return [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

function Add-VercelEnv {
  param(
    [string]$Name,
    [string]$Value,
    [string]$Environment = "production",
    [switch]$Sensitive
  )

  Test-ValidValue -Value $Value -Name "Vercel env value for $Name"
  $token = $env:VERCEL_TOKEN
  if ([string]::IsNullOrWhiteSpace($token)) {
    throw "VERCEL_TOKEN is missing. Set `$env:VERCEL_TOKEN or pass -VercelToken."
  }

  if ($Sensitive) {
    Write-Host "==> vercel env add $Name ($Environment, sensitive)"
    Write-Output $Value | vercel env add $Name $Environment --sensitive --force -t $token
  } else {
    Write-Host "==> vercel env add $Name ($Environment)"
    Write-Output $Value | vercel env add $Name $Environment --force -t $token
  }
  if ($LASTEXITCODE -ne 0) {
    throw "vercel env add failed: $Name"
  }
}

if (-not $ProjectPath) {
  $cwd = (Get-Location).Path
  $candidate1 = Join-Path $cwd "react"
  $candidate2 = Join-Path (Split-Path $cwd -Parent) "react"
  if (Test-Path $candidate1) {
    $ProjectPath = $candidate1
  } elseif (Test-Path $candidate2) {
    $ProjectPath = $candidate2
  } else {
    throw "ProjectPath not found. Provide -ProjectPath explicitly."
  }
}

Test-ValidValue -Value $ProjectPath -Name "ProjectPath"
Test-ValidValue -Value $DashUrl -Name "DashUrl"
Test-ValidValue -Value $ProxyEndpoint -Name "ProxyEndpoint"

$repoRoot = Split-Path -Path $ProjectPath -Parent
Set-Location $ProjectPath

if ($VercelToken) { $env:VERCEL_TOKEN = $VercelToken }
if (-not $env:VERCEL_TOKEN) {
  if ($PromptForMissing) {
    $env:VERCEL_TOKEN = Read-SensitiveValue -Prompt "Enter VERCEL_TOKEN"
  } else {
    throw "VERCEL_TOKEN is empty. Set `$env:VERCEL_TOKEN, pass -VercelToken, or use -PromptForMissing."
  }
}
if (-not $env:VERCEL_TOKEN -and $PromptForMissing) {
  throw "VERCEL_TOKEN input is empty."
}

$tokenValue = $env:VERCEL_TOKEN.Trim()
Test-ValueShape -Value $tokenValue -Name "VERCEL_TOKEN" -MinLength 20 -Pattern "^[A-Za-z0-9._-]+$"
$env:VERCEL_TOKEN = $tokenValue
$SecretA = if ($SecretA) { $SecretA.Trim() } else { [Environment]::GetEnvironmentVariable("AI_PROXY_ACTIVE_SIGNING_SECRET") }
if (-not $SecretA -and $PromptForMissing) {
  $SecretA = Read-SensitiveValue -Prompt "Enter AI_PROXY_ACTIVE_SIGNING_SECRET"
}
Test-ValueShape -Value $SecretA -Name "AI_PROXY_ACTIVE_SIGNING_SECRET" -MinLength 16 -Pattern "^[A-Za-z0-9.+/=_-]+$"
$env:AI_PROXY_ACTIVE_SIGNING_SECRET = $SecretA

Write-Host "==> 1) Set Vercel production AI env"
Add-VercelEnv -Name "AI_PROXY_ENABLED" -Value "1" -Environment "production"
Add-VercelEnv -Name "AI_PROXY_ENDPOINT" -Value $ProxyEndpoint -Environment "production"
Add-VercelEnv -Name "AI_PROXY_ACTIVE_SIGNING_SECRET" -Value $SecretA -Environment "production" -Sensitive
Add-VercelEnv -Name "AI_PROXY_TOKEN_ISSUER" -Value $Issuer -Environment "production"
Add-VercelEnv -Name "AI_PROXY_TOKEN_AUDIENCE" -Value $Audience -Environment "production"
Add-VercelEnv -Name "AI_PROXY_TOKEN_TTL_SECONDS" -Value "$AiProxyTtlSeconds" -Environment "production"

Write-Host "==> 2) Set preview AI disabled"
Add-VercelEnv -Name "AI_PROXY_ENABLED" -Value "0" -Environment "preview"

Write-Host "==> 3) Production redeploy"
vercel deploy --prod -y -t $tokenValue
if ($LASTEXITCODE -ne 0) {
  throw "Vercel production deploy failed."
}

Write-Host "==> 4) Cutover verification"
& "$repoRoot\standalone-package\verify-cutover.ps1" `
  -ProxyUrl $ProxyEndpoint `
  -TokenUrl "$DashUrl/api/ai/token" `
  -Origin $DashUrl `
  -ExpectedProxyEndpoint $ProxyEndpoint

if ($LASTEXITCODE -ne 0) {
  throw "Cutover verification failed."
}

if ($RunSmoke) {
  $smokeScript = "$repoRoot\.playwright\ai-ui-smoke-temp.cjs"
  if (-not (Test-Path $smokeScript)) {
    throw "AI smoke script not found: $smokeScript"
  }
  Write-Host "==> 5) AI UI smoke"
  & node $smokeScript $DashUrl $SmokeQuestion
  if ($LASTEXITCODE -ne 0) {
    throw "AI UI smoke failed."
  }
}

Write-Host "PASS: cutover flow completed."
