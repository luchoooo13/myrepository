@echo off
setlocal

echo.
echo === Instalador de autoarranque ===
echo.

set "SCRIPT_DIR=%~dp0"
set "BAT_PATH=%SCRIPT_DIR%iniciar-alertas.bat"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT=%STARTUP_DIR%\Alertas de Emergencia.lnk"

if not exist "%BAT_PATH%" (
    echo [ERROR] No encuentro "iniciar-alertas.bat" en %SCRIPT_DIR%
    echo Asegurate de ejecutar este .bat desde la carpeta "windows\" del repo.
    echo.
    pause
    exit /b 1
)

echo Carpeta del script : %SCRIPT_DIR%
echo Bat a registrar    : %BAT_PATH%
echo Carpeta de Inicio  : %STARTUP_DIR%
echo.
echo Creando acceso directo...

powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%SHORTCUT%'); $s.TargetPath = '%BAT_PATH%'; $s.WorkingDirectory = '%SCRIPT_DIR%'; $s.WindowStyle = 1; $s.Description = 'Servidor de Alertas de Emergencia'; $s.Save()"

if errorlevel 1 (
    echo.
    echo [ERROR] No se pudo crear el acceso directo.
    echo.
    pause
    exit /b 1
)

if not exist "%SHORTCUT%" (
    echo.
    echo [ERROR] PowerShell no fallo pero el acceso directo no quedo creado.
    echo.
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
echo.
pause
