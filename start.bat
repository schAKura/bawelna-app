@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ===================================================
echo           🌾 Uruchamianie BawełnaApp 🌾
echo ===================================================
echo.

:: Sprawdzenie czy Node.js jest zainstalowany
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [BLAD] Node.js nie jest zainstalowany lub nie ma go w PATH!
    echo Pobierz i zainstaluj Node.js ze strony: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: Sprawdzenie i instalacja zaleznosci jezeli folder node_modules nie istnieje
if not exist "node_modules\" (
    echo [INFO] Brak folderu node_modules. Instalowanie zaleznosci...
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo [BLAD] Nie udalo sie zainstalowac zaleznosci npm.
        pause
        exit /b 1
    )
    echo [OK] Zaleznosci zainstalowane.
    echo.
)

:: Opcjonalne automatyczne otwarcie w przegladarce po 2 sekundach w tle
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"

echo [INFO] Serwer startuje pod adresem: http://localhost:3000
echo [INFO] Mozesz otworzyc http://localhost:3000 w przegladarce.
echo [INFO] Nacisnij Ctrl+C, aby zatrzymac serwer.
echo ===================================================
echo.

node server.js

if %ERRORLEVEL% neq 0 (
    echo.
    echo [INFO] Serwer zakonczyl dzialanie z bledem.
    pause
)
