@echo off
setlocal
tasklist /FI "IMAGENAME eq Code.exe" 2>nul | find /I "Code.exe" >nul
if not errorlevel 1 (
  echo [DSH fix] VS Code is still running.
  echo Close ALL VS Code windows completely, then run this again.
  pause >nul
  exit /b 1
)
set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0fix-cache.js"
echo.
"%NODE%" "%~dp0fix-state.js"
echo.
echo [DSH fix] done. Reopen VS Code to verify.
pause >nul
