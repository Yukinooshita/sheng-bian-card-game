@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ShengBian Card Game - Self Test

set "NODE_EXE="
if exist "runtime\node.exe" set "NODE_EXE=runtime\node.exe"
if not defined NODE_EXE set "NODE_EXE=node"

echo.
echo  [1/4] rules unit test
"%NODE_EXE%" test\rules.js
if errorlevel 1 goto fail

echo.
echo  [2/4] new deck rules test
"%NODE_EXE%" test\rules_new.js
if errorlevel 1 goto fail

echo.
echo  [3/4] 100 auto-played games
"%NODE_EXE%" test\sim.js 100
if errorlevel 1 goto fail

echo.
echo  [4/4] online end-to-end test
"%NODE_EXE%" test\net.js
if errorlevel 1 goto fail

echo.
echo  ALL PASSED.
pause
exit /b 0

:fail
echo.
echo  TEST FAILED - see the error above.
pause
exit /b 1


