# Media Downloader - stop script
$procs = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -like "python*" -and $_.CommandLine -match "uvicorn main:app"
}
if (-not $procs) {
    Write-Host "No Media Downloader server is running." -ForegroundColor Green
} else {
    foreach ($p in $procs) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped PID $($p.ProcessId)" -ForegroundColor Yellow
    }
    Start-Sleep -Seconds 1
}

$still = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if ($still) { Write-Host "WARNING: port 8000 still held by PID $($still.OwningProcess)" -ForegroundColor Red }
else { Write-Host "Port 8000 is free." -ForegroundColor Green }
