param(
  [Parameter(Mandatory = $true)]
  [string]$ProxyUrl,
  [Parameter(Mandatory = $true)]
  [string]$TokenUrl,
  [string]$Origin = "https://iran-abu-dash.vercel.app",
[string]$ExpectedProxyEndpoint = "",
[string]$ForbiddenOrigin = "https://forbidden.invalid"
)

function Invoke-WebRequestStatus {
  param(
    [string]$Method,
    [string]$Url,
    [hashtable]$Headers = @{},
    [string]$Body = "",
    [bool]$ReturnContent = $true
  )

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
    $response = $_.Exception.Response
    $detail = $_.Exception.Message
    if (-not $response) {
      return [PSCustomObject]@{
        StatusCode = 0
        Content = $null
        ErrorMessage = $detail
      }
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
  if (-not (Assert-Status "chat with minted token" $chat.StatusCode @(200, 409, 422))) { $failures++ }
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
