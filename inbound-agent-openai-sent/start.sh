#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 22+ from https://nodejs.org/ first.'
  exit 1
fi
# An installed pnpm, else the Corepack shim bundled with Node 22–24 (pinned by "packageManager" in package.json).
if command -v pnpm >/dev/null 2>&1; then pnpm=pnpm
elif command -v corepack >/dev/null 2>&1; then pnpm='corepack pnpm'
else echo 'Install pnpm from https://pnpm.io/installation first.'; exit 1
fi
# dist/ ships prebuilt, so running the app needs production dependencies only.
if [ ! -d node_modules ]; then $pnpm install --frozen-lockfile --prod; fi
exec $pnpm start
