#!/usr/bin/env bash
set -e

echo ""
echo " =========================================="
echo "  HireSignal - Personal Job Assistant"
echo " =========================================="
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo " ERROR: Node.js is not installed."
  echo " Download from: https://nodejs.org (LTS version)"
  echo " Then run: bash start.sh"
  exit 1
fi
echo " Node.js $(node --version) found."

# Install dependencies (first-time only)
if [ ! -d "node_modules" ]; then
  echo ""
  echo " Installing dependencies (first-time ~1-2 min)..."
  npm install --prefer-offline --no-audit --no-fund
  echo " Dependencies installed."
fi

# Install Playwright browser if needed
if [ ! -d "node_modules/playwright-core/.local-chromium" ] && \
   [ ! -d "node_modules/playwright/.local-chromium" ]; then
  echo ""
  echo " Installing browser engine (one-time ~150 MB)..."
  npx playwright install chromium
fi

# Create data directories
mkdir -p data/playwright

# Open browser after delay
(sleep 10 && open http://localhost:3000 2>/dev/null || \
  xdg-open http://localhost:3000 2>/dev/null || true) &

echo ""
echo " Starting HireSignal at http://localhost:3000"
echo " Press Ctrl+C to stop."
echo ""
npm run dev