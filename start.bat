@echo off
setlocal enabledelayedexpansion
title HireMe - Personal Job Assistant

echo.
echo  ==========================================
echo   HireMe - Personal Job Assistant
echo  ==========================================
echo.
echo  First-time setup: get a FREE Gemini API key at
echo  https://aistudio.google.com/apikey  then paste it
echo  in Settings (top-right) after the app opens.
echo.

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
  echo  ERROR: Node.js is not installed.
  echo  Download from: https://nodejs.org (LTS version)
  echo  Then run start.bat again.
  pause
  exit /b 1
)
echo  Node.js found.

:: Install npm dependencies (first-time only)
if not exist node_modules (
  echo.
  echo  Installing dependencies (first-time setup ~1-2 minutes)...
  call npm install --prefer-offline --no-audit --no-fund
  if errorlevel 1 (
    echo  ERROR: npm install failed. Check internet connection.
    pause
    exit /b 1
  )
  echo  Dependencies installed.
)

:: Install Playwright browser if needed (required for auto-apply automation)
:: Ollama is NOT required - configure a free Gemini key in the app Settings instead.
if not exist "node_modules\playwright-core\.local-chromium" (
  if not exist "node_modules\playwright\.local-chromium" (
    echo.
    echo  Installing browser engine (one-time ~150 MB download)...
    call npx playwright install chromium
  )
)

:: Create data directories
if not exist data mkdir data
if not exist "data\playwright" mkdir "data\playwright"

:: Launch app + open browser after 10s delay
echo.
echo  Starting HireMe at http://localhost:3001
echo  Press Ctrl+C to stop.
echo.
start /min "" cmd /c "timeout /t 10 /nobreak >nul && start http://localhost:3001"
call npm run dev -- --port 3001
endlocal
