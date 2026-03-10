@echo off
setlocal

cd /d "%~dp0"

if not exist "dist\cli.js" (
  echo dist\cli.js not found. Run build.bat first.
  exit /b 1
)

if "%MYAGENT_PROXY_HOST%"=="" set MYAGENT_PROXY_HOST=127.0.0.1
if "%MYAGENT_PROXY_PORT%"=="" set MYAGENT_PROXY_PORT=3010
if "%MYAGENT_PROXY_OPS_LOGS%"=="" set MYAGENT_PROXY_OPS_LOGS=1
if "%MYAGENT_PROXY_ALLOW_SANITIZED_TO_COPILOT%"=="" set MYAGENT_PROXY_ALLOW_SANITIZED_TO_COPILOT=1

node dist\cli.js serve --host %MYAGENT_PROXY_HOST% --port %MYAGENT_PROXY_PORT%
