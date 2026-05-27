#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "Stopping existing trackedg process if present..."
pm2 delete trackedg 2>/dev/null || true

echo "Installing dependencies..."
npm install

echo "Building project..."
npm run build

echo "Starting trackedg with production start command..."
pm2 start npm --name trackedg --cwd "$REPO_ROOT" -- start

echo "Restart complete. Verify with: curl http://87.106.214.100:3000/api/debug"