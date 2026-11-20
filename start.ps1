# Skrypt PowerShell do uruchamiania BawełnaApp
$ErrorActionPreference = "Stop"

Set-Location -Path $PSScriptRoot

Write-Host "===================================================" -ForegroundColor Green
Write-Host "          🌾 Uruchamianie BawełnaApp 🌾" -ForegroundColor Yellow
Write-Host "===================================================" -ForegroundColor Green

# Sprawdzenie Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[BŁĄD] Node.js nie został znaleziony w systemie!" -ForegroundColor Red
    Write-Host "Pobierz Node.js z: https://nodejs.org/"
    Read-Host "Naciśnij Enter, aby zakończyć..."
    exit 1
}

# Instalacja pakietów, jeśli brak node_modules
if (-not (Test-Path "node_modules")) {
    Write-Host "[INFO] Instalowanie zależności npm..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[BŁĄD] Instalacja zależności nie powiodła się." -ForegroundColor Red
        exit 1
    }
}

# Otwarcie w przeglądarce
Start-Process "http://localhost:3000"

Write-Host "[INFO] Uruchamianie serwera na http://localhost:3000..." -ForegroundColor Cyan
Write-Host "[INFO] Naciśnij Ctrl+C, aby zatrzymać serwer." -ForegroundColor Gray
Write-Host "===================================================" -ForegroundColor Green

node server.js
