@echo off
setlocal

cd /d "%~dp0"

if not exist "dist\cli.js" (
  echo dist\cli.js not found. Run build.bat first.
  exit /b 1
)

if "%MYAGENT_PROXY_CORS_ORIGINS%"=="" (
  echo MYAGENT_PROXY_CORS_ORIGINS is required.
  exit /b 1
)

if "%MYAGENT_PROXY_AUTH_MODE%"=="" set MYAGENT_PROXY_AUTH_MODE=jwt

if /I "%MYAGENT_PROXY_AUTH_MODE%"=="jwt" (
  if "%MYAGENT_PROXY_TOKEN_SIGNING_SECRETS%"=="" (
    echo MYAGENT_PROXY_TOKEN_SIGNING_SECRETS is required for jwt mode.
    exit /b 1
  )
) else if /I "%MYAGENT_PROXY_AUTH_MODE%"=="shared" (
  if "%MYAGENT_PROXY_AUTH_TOKEN%"=="" (
    echo MYAGENT_PROXY_AUTH_TOKEN is required for shared mode.
    exit /b 1
  )
) else if /I "%MYAGENT_PROXY_AUTH_MODE%"=="hybrid" (
  if "%MYAGENT_PROXY_TOKEN_SIGNING_SECRETS%"=="" if "%MYAGENT_PROXY_AUTH_TOKEN%"=="" (
    echo MYAGENT_PROXY_TOKEN_SIGNING_SECRETS or MYAGENT_PROXY_AUTH_TOKEN is required for hybrid mode.
    exit /b 1
  )
) else (
  echo Unsupported MYAGENT_PROXY_AUTH_MODE=%MYAGENT_PROXY_AUTH_MODE%
  exit /b 1
)

if "%MYAGENT_PROXY_HOST%"=="" set MYAGENT_PROXY_HOST=127.0.0.1
if "%MYAGENT_PROXY_PORT%"=="" set MYAGENT_PROXY_PORT=3010
if "%MYAGENT_PROXY_OPS_LOGS%"=="" set MYAGENT_PROXY_OPS_LOGS=1
if "%MYAGENT_PROXY_ALLOW_SANITIZED_TO_COPILOT%"=="" set MYAGENT_PROXY_ALLOW_SANITIZED_TO_COPILOT=0
if "%MYAGENT_PROXY_REQUIRE_PUBLIC_GUARDS%"=="" set MYAGENT_PROXY_REQUIRE_PUBLIC_GUARDS=1
if "%MYAGENT_PROXY_ALLOW_INSECURE_PUBLIC%"=="" set MYAGENT_PROXY_ALLOW_INSECURE_PUBLIC=0
if "%MYAGENT_PROXY_TOKEN_ISSUER%"=="" set MYAGENT_PROXY_TOKEN_ISSUER=iran-abu-dash
if "%MYAGENT_PROXY_TOKEN_AUDIENCE%"=="" set MYAGENT_PROXY_TOKEN_AUDIENCE=myagent-copilot-standalone

node dist\cli.js serve --host %MYAGENT_PROXY_HOST% --port %MYAGENT_PROXY_PORT%
