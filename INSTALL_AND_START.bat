@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo Maps Owner Finder - Install and Start
 echo ========================================

call npm install
if errorlevel 1 goto :error

start "" http://localhost:3000
call npm run dev

goto :eof

:error
echo.
echo Installation or startup failed.
pause
exit /b 1
