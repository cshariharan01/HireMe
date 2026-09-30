#!/usr/bin/env bash
set -e

echo ""
echo " =========================================="
echo "  HireMe - Personal Job Assistant"
echo " =========================================="
echo ""
echo " First-time setup: get a FREE Gemini API key at"
echo " https://aistudio.google.com/apikey then paste it"
echo " in Settings after the app opens."
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

# Check if Chrome / Chromium is installed
CHROME_FOUND=0
if [ -d "/Applications/Google Chrome.app" ] || command -v google-chrome &>/dev/null || command -v google-chrome-stable &>/dev/null || command -v chromium-browser &>/dev/null || command -v chromium &>/dev/null; then
  CHROME_FOUND=1
  echo " Google Chrome / Chromium detected on system."
fi

if [ "$CHROME_FOUND" -eq 0 ]; then
  if [ ! -d "node_modules/playwright-core/.local-chromium" ] && \
     [ ! -d "node_modules/playwright/.local-chromium" ]; then
    echo ""
    echo " Chrome not found. Installing browser engine (one-time ~150 MB)..."
    npx playwright install chromium
  fi
fi

# Create data directories
mkdir -p data/playwright

# Open browser after delay
(sleep 10 && open http://localhost:3001 2>/dev/null || \
  xdg-open http://localhost:3001 2>/dev/null || true) &

echo ""
echo " Starting HireMe at http://localhost:3001"
echo " Press Ctrl+C to stop."
echo ""
npm run dev -- --port 3001