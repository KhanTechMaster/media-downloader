# Media Downloader - start script
# Usage: .\run.ps1   (then open http://127.0.0.1:8000)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# Guard: never start a second instance
$listener = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $owner = $listener.OwningProcess | Select-Object -First 1
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $owner" -ErrorAction SilentlyContinue
    Write-Host "Port 8000 is already in use by PID $owner ($($proc.Name))." -ForegroundColor Yellow
    Write-Host "Open http://127.0.0.1:8000 or run .\stop.ps1 first." -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path ".venv")) {
    python -m venv .venv
    .\.venv\Scripts\python.exe -m pip install --upgrade pip
}

.\.venv\Scripts\python.exe -m pip install -q -r requirements.txt

# ffmpeg: make it visible to this session if winget installed it
$ff = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg_*" -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($ff) { $env:Path = "$($ff.DirectoryName);$env:Path" }

Write-Host "Starting Media Downloader on http://127.0.0.1:8000" -ForegroundColor Cyan
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
