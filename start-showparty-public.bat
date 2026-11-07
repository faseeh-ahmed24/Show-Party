@echo off
title ShowParty — Public Watch Party (Cloudflare Tunnel)
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

node server/tunnelLauncher.js

echo.
pause
