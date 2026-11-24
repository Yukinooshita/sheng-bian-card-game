@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Upvard Card Game Server
echo ============================================
echo   Upvard Card Game  -  local server
echo --------------------------------------------
echo   Address : http://127.0.0.1:8080
echo   Keep this window open while playing.
echo   Close this window to stop the server.
echo ============================================
echo.

if exist "runtime\node.exe" (
  set "NODEEXE=runtime\node.exe"
  goto run
)

where node >nul 2>nul
if not errorlevel 1 (
  set "NODEEXE=node"
  goto run
)

echo  Node runtime not found. Downloading it now (about 34 MB, once only)...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0get-node.ps1"
if not exist "runtime\node.exe" (
  echo.
  echo  Download failed. Install Node.js from https://nodejs.org and try again.
  pause >nul
  exit /b 1
)
set "NODEEXE=runtime\node.exe"

:run
start "" /b cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8080"
"%NODEEXE%" server.js
echo.
echo Server stopped.
pause >nul
