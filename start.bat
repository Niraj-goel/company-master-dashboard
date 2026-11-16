@echo off
rem Starts the Company Master Dashboard. Settings (port, password, Google key) are in .env
cd /d "%~dp0"
set PORT=
for /f "tokens=1,* delims==" %%a in ('findstr /b "PORT=" .env') do set PORT=%%b
if "%PORT%"=="" set PORT=3000
start "" http://localhost:%PORT%
node server.js
pause
