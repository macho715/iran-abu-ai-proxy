@echo off
setlocal

cd /d "%~dp0"

if not exist "node_modules" (
  echo Installing dependencies...
  call pnpm install
  if errorlevel 1 exit /b 1
)

echo Building standalone package...
call pnpm build
if errorlevel 1 exit /b 1

echo Build complete.
echo To export a portable zip, run export-release.bat
