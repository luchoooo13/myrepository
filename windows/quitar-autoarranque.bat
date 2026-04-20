@echo off
rem ---------------------------------------------------------------
rem  Quita el acceso directo de "iniciar-alertas.bat" de la carpeta
rem  de Inicio de Windows, asi deja de arrancar solo con la compu.
rem ---------------------------------------------------------------

setlocal
set STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set SHORTCUT=%STARTUP_DIR%\Alertas de Emergencia.lnk

if exist "%SHORTCUT%" (
    del /q "%SHORTCUT%"
    echo Autoarranque desinstalado.
) else (
    echo No habia autoarranque instalado. Nada que hacer.
)
pause
