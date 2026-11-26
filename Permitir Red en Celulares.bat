@echo off
chcp 65001 >nul
title Permitir Conexion de Celulares (Puerto 3000)

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Solicitando permisos de Administrador para abrir el puerto 3000 en la red Wi-Fi local...
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

netsh advfirewall firewall delete rule name="Control Pagos Bancolombia (Telefonos)" >nul 2>&1
netsh advfirewall firewall add rule name="Control Pagos Bancolombia (Telefonos)" dir=in action=allow protocol=TCP localport=3000 profile=private,domain,public

echo.
echo ====================================================================
echo   LISTO: El puerto 3000 quedo habilitado en el Firewall de Windows.
echo   Ya puedes conectar tus 2 o 3 telefonos por Wi-Fi escaneando el QR.
echo ====================================================================
echo.
pause
