@echo off
setlocal

cd /d "%~dp0"

if not exist "dist\cli.js" (
  echo dist\cli.js not found. Run build.bat first.
  exit /b 1
)

node dist\cli.js usage --json
