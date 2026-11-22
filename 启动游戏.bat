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
if exist "runtime\node.exe" (set "NODEEXE=runtime\node.exe") else (set "NODEEXE=node")
start "" /b cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8080"
"%NODEEXE%" server.js
echo.
echo Server stopped.
pause >nul
