@echo off
chcp 65001 >nul
title Control de Pagos Bancolombia
cd /d "%~dp0"

echo ============================================================
echo   INICIANDO CONTROL DE PAGOS BANCOLOMBIA...
echo   No cierres esta ventana mientras estes recibiendo pagos.
echo ============================================================
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3000'"
node server.js
pause
