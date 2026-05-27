#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "Pulling latest changes..."
git pull --ff-only

echo "Installing dependencies..."
npm install

echo "Building project..."
npm run build

if command -v pm2 >/dev/null 2>&1; then
  echo "Restarting PM2 app 'trackedg'..."
  if ! pm2 restart trackedg; then
    echo "PM2 process 'trackedg' not found; starting it instead."
    pm2 start npm --name trackedg -- start
  fi
else
  echo "pm2 not installed or not available on PATH. Skipping PM2 restart."
fi

echo "Post-pull deployment complete."
