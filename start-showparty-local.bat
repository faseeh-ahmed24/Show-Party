@echo off
title ShowParty — Local & Wi-Fi Watch Party
cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not in your system PATH.
    echo Please install Node.js LTS from https://nodejs.org/ and try again.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo Installing required npm packages...
    call npm install
    echo.
)

echo ============================================================
echo   ShowParty — Local / Same Wi-Fi Mode (No Cloudflare Tunnel)
echo   Press Ctrl+C or close this window at any time to stop.
echo ============================================================
echo.

node server/server.js

echo.
pause
