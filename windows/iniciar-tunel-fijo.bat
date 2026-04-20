@echo off
rem ---------------------------------------------------------------
rem  Tunel HTTPS con URL FIJA (ngrok) -> localhost:3000
rem
rem  Esta version usa ngrok con una cuenta gratis para que la URL
rem  publica NUNCA cambie. Asi les pasas la URL una sola vez a los
rem  profes y listo.
rem
rem  Requisitos (una sola vez, lee LEEME.txt para los pasos):
rem   * Cuenta gratis en https://dashboard.ngrok.com/signup
rem   * Authtoken copiado de
rem       https://dashboard.ngrok.com/get-started/your-authtoken
rem   * Dominio estatico reclamado en
rem       https://dashboard.ngrok.com/domains
rem     (algo como "tu-nombre.ngrok-free.app")
rem   * Esos dos datos pegados en ngrok-config.txt
rem ---------------------------------------------------------------

setlocal ENABLEDELAYEDEXPANSION
cd /d "%~dp0"

if not exist "ngrok-config.txt" (
    echo.
    echo [!] No encontre ngrok-config.txt en esta carpeta.
    echo     Abri LEEME.txt para ver como configurarlo.
    echo.
    pause
    exit /b 1
)

set "AUTHTOKEN="
set "URL="
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("ngrok-config.txt") do (
    set "K=%%A"
    set "V=%%B"
    if /i "!K!"=="authtoken" set "AUTHTOKEN=!V!"
    if /i "!K!"=="url"       set "URL=!V!"
)

if not defined AUTHTOKEN (
    echo [!] Falta "authtoken=..." en ngrok-config.txt
    pause
    exit /b 1
)
if not defined URL (
    echo [!] Falta "url=..." en ngrok-config.txt
    pause
    exit /b 1
)

set "NGROK=%~dp0ngrok.exe"
if not exist "%NGROK%" (
    echo.
    echo =====================================================
    echo  Descargando ngrok.exe ^(primera vez, ~15 MB^)...
    echo =====================================================
    echo.
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip' -OutFile 'ngrok.zip' -UseBasicParsing; Expand-Archive -Path 'ngrok.zip' -DestinationPath '.' -Force; Remove-Item 'ngrok.zip' -Force } catch { Write-Host $_; exit 1 }"
    if errorlevel 1 (
        echo.
        echo [ERROR] No se pudo descargar ngrok.
        pause
        exit /b 1
    )
    echo.
    echo [OK] ngrok.exe descargado.
    echo.
)

title Tunel fijo SchoolAlerts (ngrok)

"%NGROK%" config add-authtoken %AUTHTOKEN% >nul 2>&1

echo.
echo =====================================================
echo  Abriendo tunel fijo
echo    https://%URL%   -^>   http://localhost:3000
echo  No cierres esta ventana mientras quieras usar la app.
echo =====================================================
echo.

"%NGROK%" http --url=%URL% 3000 --log=stdout

echo.
echo [!] El tunel se cerro. Volve a abrir este .bat para re-iniciar.
pause
