@echo off
cd /d "%~dp0.."
where node >nul 2>&1 || (echo Install Node.js 20+ and retry & pause & exit /b 1)
where ffmpeg >nul 2>&1 || echo WARNING: ffmpeg not on PATH — Windows loopback will fail
call npm start
pause
