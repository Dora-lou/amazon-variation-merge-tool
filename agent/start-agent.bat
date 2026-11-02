@echo off
setlocal
cd /d "%~dp0.."
where py >nul 2>nul
if not errorlevel 1 (
  py -3 agent\server.py
) else (
  python agent\server.py
)
if errorlevel 1 (
  echo.
  echo Agent startup failed. Check Python 3 and Codex installation.
)
pause