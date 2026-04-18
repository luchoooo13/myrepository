@echo off
rem ---------------------------------------------------------------
rem  Inicia el servidor de alertas. Este .bat lo pone el script
rem  "instalar-autoarranque.bat" en la carpeta de inicio de Windows
rem  para que el server arranque solo cuando prendes la compu.
rem ---------------------------------------------------------------

rem Nos movemos a la carpeta donde esta este .bat (el .bat vive en
rem <repo>\windows\, asi que subimos un nivel para quedar en el repo).
cd /d "%~dp0.."

title Servidor de Alertas de Emergencia

rem Si es la primera vez, instalamos dependencias.
if not exist node_modules (
    echo [setup] node_modules no encontrado, instalando dependencias...
    call npm install
)

echo.
echo =====================================================
echo  Servidor de Alertas de Emergencia
echo  (no cierres esta ventana mientras uses la app)
echo =====================================================
echo.

rem npm start siempre en primer plano. Si falla, esperamos 5s y
rem lo relanzamos (por si la red/IP tardo en estar lista al boot).
:loop
call npm start
echo.
echo [!] El servidor se cerro. Reintentando en 5 segundos... (Ctrl+C para abortar)
timeout /t 5 /nobreak >nul
goto loop
