@echo off
rem ---------------------------------------------------------------
rem  Registra "iniciar-alertas.bat" para que arranque solo cuando
rem  prendes la compu. Hace dos cosas:
rem    1) Crea un acceso directo de iniciar-alertas.bat en la
rem       carpeta de Inicio de Windows (%APPDATA%\Microsoft\Windows\
rem       Start Menu\Programs\Startup).
rem    2) Pide una vez que confirmes el Firewall de Windows (al primer
rem       arranque desde npm start ya te lo pide solo).
rem  Para quitarlo: correr "quitar-autoarranque.bat" (al lado).
rem ---------------------------------------------------------------

setlocal
set SCRIPT_DIR=%~dp0
set BAT_PATH=%SCRIPT_DIR%iniciar-alertas.bat
set STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set SHORTCUT=%STARTUP_DIR%\Alertas de Emergencia.lnk

if not exist "%BAT_PATH%" (
    echo.
    echo [ERROR] No encuentro "iniciar-alertas.bat" en %SCRIPT_DIR%
    echo Asegurate de ejecutar este .bat desde la misma carpeta.
    pause
    exit /b 1
)

echo Creando acceso directo en la carpeta de Inicio de Windows...

rem Creamos el .lnk con PowerShell (viene con Windows 10/11).
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%SHORTCUT%');" ^
    "$s.TargetPath = '%BAT_PATH%';" ^
    "$s.WorkingDirectory = '%SCRIPT_DIR%';" ^
    "$s.WindowStyle = 1;" ^
    "$s.Description = 'Servidor de Alertas de Emergencia';" ^
    "$s.Save()"

if errorlevel 1 (
    echo.
    echo [ERROR] No se pudo crear el acceso directo.
    pause
    exit /b 1
)

echo.
echo =====================================================
echo  LISTO - autoarranque instalado.
echo.
echo  La proxima vez que prendas la compu, se va a abrir
echo  sola una ventana de CMD con el servidor corriendo.
echo  NO CIERRES esa ventana mientras uses la app
echo  (podes minimizarla).
echo.
echo  Para desinstalar: corre "quitar-autoarranque.bat"
echo  (al lado de este archivo).
echo =====================================================
pause
