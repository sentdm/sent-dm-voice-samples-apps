@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22+ from https://nodejs.org/ first.
  pause
  exit /b 1
)
rem An installed pnpm, else the Corepack shim bundled with Node 22-24 (pinned by "packageManager" in package.json).
set "PNPM=pnpm"
where pnpm >nul 2>nul
if errorlevel 1 (
  where corepack >nul 2>nul
  if errorlevel 1 (
    echo Install pnpm from https://pnpm.io/installation first.
    pause
    exit /b 1
  )
  set "PNPM=corepack pnpm"
)
rem dist\ ships prebuilt, so running the app needs production dependencies only.
if not exist node_modules (
  call %PNPM% install --frozen-lockfile --prod
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call %PNPM% start
pause
