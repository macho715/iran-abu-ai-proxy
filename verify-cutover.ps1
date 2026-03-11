param(
  [Parameter(Mandatory = $true)]
  [string]$ProxyUrl,
  [Parameter(Mandatory = $true)]
  [string]$TokenUrl,
  [string]$Origin = "https://iran-abu-dash.vercel.app",
  [string]$ExpectedProxyEndpoint = "",
  [string]$ForbiddenOrigin = "https://forbidden.invalid"
)

function Get-ErrorBodyFromWebException {
  param(
    [Parameter(Mandatory=$true)]$Exception
  )

  try {
    if ($Exception.ErrorDetails -and $Exception.ErrorDetails.Message) {
      return $Exception.ErrorDetails.Message
    }
  } catch {}

  try {
    $resp = $Exception.Response
    if ($resp -and $resp.Content -is [byte[]]) {
      return [Text.Encoding]::UTF8.GetString($resp.Content)
    }
  } catch {}

  return ""
}

function Invoke-WebRequestStatus {
  param(
    [string]$Method,
    [string]$Url,
    [hashtable]$Headers = @{},
    [string]$Body = "",
    [bool]$ReturnContent = $true
  )

  function Get-ErrorBody {
    param([object]$Response)
    try {
      if ($Response.Content -is [string]) { return $Response.Content }
      if ($Response.Content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($Response.Content) }
      if ($Response.Content -is [System.Net.Http.HttpContent]) {
        return $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      }
    } catch {}

    try {
      $stream = $Response.GetResponseStream()
      $reader = New-Object System.IO.StreamReader($stream)
      $text = $reader.ReadToEnd()
      $reader.Close()
      return $text
    } catch {}

    try {
      return $Response.Content | Out-String
    } catch {}

    return ""
  }

  $params = @{
    Uri = $Url
    Method = $Method
    Headers = $Headers
    UseBasicParsing = $true
  }

  if ($Body) {
    $params.Body = $Body
    $params.ContentType = "application/json"
  }

  try {
    $response = Invoke-WebRequest @params -ErrorAction Stop
  } catch {
    $ex = $_.Exception
    $response = $ex.Response
    $detail = Get-ErrorBodyFromWebException -Exception $ex

    if (-not $response) {
      return [PSCustomObject]@{
        StatusCode = 0
        Content = ""
        ErrorMessage = $detail
      }
    }

    $body = Get-ErrorBody -Response $response
    if (-not $body) { $body = $detail }

    return [PSCustomObject]@{
      StatusCode   = [int]$response.StatusCode
      Content      = $body
      ErrorMessage = $detail
    }
  }

  if ($ReturnContent) {
    return [PSCustomObject]@{
      StatusCode = [int]$response.StatusCode
      Content = $response.Content
      ErrorMessage = ""
    }
  }
  return [PSCustomObject]@{
    StatusCode = [int]$response.StatusCode
    Content = ""
    ErrorMessage = ""
  }
}

function Invoke-CurlBodyFallback {
  param(
    [string]$Method,
    [string]$Url,
    [hashtable]$Headers = @{},
    [string]$Body = ""
  )

  $headerArgs = @()
  foreach ($entry in $Headers.GetEnumerator()) {
    $headerArgs += "-H"
    $headerArgs += "$($entry.Key): $($entry.Value)"
  }

  $bodyArgs = @()
  if ($Body) {
    $bodyArgs = @("--data", $Body)
  }

  $temp = & curl.exe -sS -i -X $Method $headerArgs $bodyArgs --max-time 30 $Url
  if ($LASTEXITCODE -ne 0 -or -not $temp) {
    return ""
  }

  $lines = $temp -split "`r?`n"
  $bodyStart = 0
  for ($i = 0; $i -lt $lines.Length - 1; $i++) {
    if ([string]::IsNullOrWhiteSpace($lines[$i])) {
      $bodyStart = $i + 1
      break
    }
  }

  if ($bodyStart -ge $lines.Length) {
    return ""
  }

  return ($lines[$bodyStart..($lines.Length - 1)] -join "`n").Trim()
}

function Assert-Status {
  param([string]$Name, [int]$Actual, [int[]]$Expected)
  if ($Expected -contains $Actual) {
    Write-Host "[PASS] $Name"
    return $true
  }
  Write-Host "[FAIL] $Name : status=$Actual (expected $($Expected -join ','))"
  return $false
}

$failures = 0
$chatPayload = '{"model":"github-copilot/gpt-5-mini","sensitivity":"internal","messages":[{"role":"user","content":"ping"}]}'

if ($ProxyUrl -like "*/api/ai/chat") {
  $ProxyBase = $ProxyUrl -replace "/api/ai/chat/?$", ""
} elseif ($ProxyUrl -like "*/api/ai") {
  $ProxyBase = $ProxyUrl -replace "/api/ai/?$", ""
} else {
  $ProxyBase = $ProxyUrl.TrimEnd("/")
}

Write-Host "==> GET $ProxyBase/api/ai/health"
$health = Invoke-WebRequestStatus -Method GET -Url "$ProxyBase/api/ai/health"
if (-not (Assert-Status "health" $health.StatusCode @(200))) { $failures++ }

Write-Host "==> OPTIONS preflight allowed origin"
$preflightOk = Invoke-WebRequestStatus -Method OPTIONS -Url "$ProxyBase/api/ai/chat" -Headers @{ Origin = $Origin; "Access-Control-Request-Method" = "POST" }
if (-not (Assert-Status "preflight allowed" $preflightOk.StatusCode @(204))) { $failures++ }

Write-Host "==> OPTIONS preflight forbidden origin"
$preflightForbidden = Invoke-WebRequestStatus -Method OPTIONS -Url "$ProxyBase/api/ai/chat" -Headers @{ Origin = $ForbiddenOrigin; "Access-Control-Request-Method" = "POST" }
if (-not (Assert-Status "preflight forbidden" $preflightForbidden.StatusCode @(403))) { $failures++ }

Write-Host "==> GET $TokenUrl"
$tokenResp = Invoke-WebRequestStatus -Method GET -Url $TokenUrl
if (-not (Assert-Status "token mint endpoint" $tokenResp.StatusCode @(200))) { $failures++ }
if ($tokenResp.ErrorMessage) {
  Write-Host "[INFO] token endpoint error detail: $($tokenResp.ErrorMessage)"
}
if ($tokenResp.StatusCode -eq 403) {
  Write-Host "[INFO] token endpoint returned 403. If AI is disabled in Vercel env, set AI_PROXY_ENABLED=1 and redeploy."
}

$tokenPayload = $null
if ($tokenResp.Content) {
  try {
    $tokenPayload = $tokenResp.Content | ConvertFrom-Json -ErrorAction Stop
  } catch {
    $tokenPayload = $null
  }
}

$token = if ($tokenPayload -and $tokenPayload.token) { $tokenPayload.token } else { "" }
$mintedEndpoint = if ($tokenPayload -and $tokenPayload.endpoint) { $tokenPayload.endpoint } else { "" }

if ($ExpectedProxyEndpoint -and $mintedEndpoint -ne $ExpectedProxyEndpoint) {
  Write-Host "[FAIL] minted endpoint mismatch: expected=$ExpectedProxyEndpoint got=$mintedEndpoint"
  $failures++
} elseif ($ExpectedProxyEndpoint -and $mintedEndpoint) {
  Write-Host "[PASS] minted endpoint match"
}

if ($token) {
  Write-Host "==> POST /api/ai/chat with minted token"
  $chat = Invoke-WebRequestStatus -Method POST -Url "$ProxyBase/api/ai/chat" -Headers @{
    Origin = $Origin
    "x-ai-proxy-token" = $token
  } -Body $chatPayload
  if (-not (Assert-Status "chat with minted token" $chat.StatusCode @(200, 409, 422))) {
    $failures++
    if ($chat.Content -and ($chat.Content -is [string]) -and ($chat.Content -notmatch "^\s*Headers\r?\n-------")) {
      Write-Host "[INFO] chat error body: $($chat.Content)"
    } elseif ($chat.ErrorMessage) {
      Write-Host "[INFO] chat error detail: $($chat.ErrorMessage)"
    }

    if (-not $chat.Content -or -not ($chat.Content -is [string]) -or ($chat.Content -match "^\s*Headers\r?\n-------")) {
      $fallbackBody = Invoke-CurlBodyFallback -Method "POST" -Url "$ProxyBase/api/ai/chat" -Headers @{
        Origin = $Origin
        "x-ai-proxy-token" = $token
        "Content-Type" = "application/json"
      } -Body $chatPayload
      if ($fallbackBody) { Write-Host "[INFO] chat curl fallback body: $fallbackBody" }
    }
  }
} else {
  Write-Host "[FAIL] token parsing failed"
  $failures++
}

Write-Host "==> POST /api/ai/chat with invalid token"
  $invalid = Invoke-WebRequestStatus -Method POST -Url "$ProxyBase/api/ai/chat" -Headers @{
    Origin = $Origin
    "x-ai-proxy-token" = "invalid.$([guid]::NewGuid().ToString()).token"
  } -Body $chatPayload
if (-not (Assert-Status "chat invalid token" $invalid.StatusCode @(401, 403))) { $failures++ }

if ($failures -gt 0) {
  throw "Cutover verification failed: $failures failures"
}

Write-Host "Cutover verification passed."
