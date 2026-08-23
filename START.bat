@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo Maps Owner Finder - Starting...
echo ========================================

if not exist node_modules (
  echo node_modules not found. Installing dependencies...
  call npm install
  if errorlevel 1 goto :error
)

start "" http://localhost:3000
call npm run dev

goto :eof

:error
echo.
echo Failed to start Maps Owner Finder.
pause
exit /b 1
