@echo off
rem ---------------------------------------------------------------
rem  Abre un tunel HTTPS de Cloudflare hacia el server local
rem  (http://localhost:3000). Devuelve una URL publica tipo
rem  https://xxxxxxxx.trycloudflare.com que los profes pueden
rem  abrir desde cualquier dispositivo (iPad, iPhone, Android).
rem
rem  Lo necesitamos porque Safari de iOS no deja activar las
rem  notificaciones push en sitios HTTP plano - requiere HTTPS.
rem
rem  Sin cuenta, sin costo. La URL cambia cada vez que se
rem  reinicia el tunel.
rem ---------------------------------------------------------------

setlocal ENABLEDELAYEDEXPANSION
cd /d "%~dp0"

set "CLOUDFLARED=%~dp0cloudflared.exe"
set "DOWNLOAD_URL=https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"

title Tunel SchoolAlerts (Cloudflare)

if not exist "%CLOUDFLARED%" (
    echo.
    echo =====================================================
    echo  Descargando cloudflared.exe ^(~20 MB, primera vez^)...
    echo =====================================================
    echo.
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%DOWNLOAD_URL%' -OutFile '%CLOUDFLARED%' -UseBasicParsing } catch { Write-Host $_; exit 1 }"
    if errorlevel 1 (
        echo.
        echo [ERROR] No se pudo descargar cloudflared.exe.
        echo Revisa tu conexion a internet y volve a correr este .bat.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo [OK] cloudflared.exe descargado.
    echo.
)

echo.
echo =====================================================
echo  Abriendo tunel Cloudflare -^> http://localhost:3000
echo  No cierres esta ventana mientras quieras usar la app.
echo  La URL publica va a aparecer abajo en unos segundos.
echo  Busca la linea que diga "https://xxxx.trycloudflare.com"
echo =====================================================
echo.

"%CLOUDFLARED%" tunnel --url http://localhost:3000 --no-autoupdate

echo.
echo [!] El tunel se cerro. Volve a abrir este .bat para re-iniciar.
pause
