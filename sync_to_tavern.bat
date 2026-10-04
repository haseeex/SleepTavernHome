@echo off
rem ASCII-only launcher for the Dream Card Agent -> SillyTavern plugin sync.
rem Usage:
rem   sync_to_tavern.bat            build + sync
rem   sync_to_tavern.bat nobuild    skip build, sync only
setlocal
cd /d "%~dp0"

set "ARGS="
if /i "%~1"=="nobuild" set "ARGS=--nobuild"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  exit /b 1
)

node "util\sync_to_tavern.mjs" %ARGS%
exit /b %ERRORLEVEL%