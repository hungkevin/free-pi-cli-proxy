# kill-6447.ps1
# 關閉佔用 port 6447 的 bun 進程，釋放 port 以便重新啟動 proxy
Get-Process -Name "bun" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Write-Host "Port 6447 已釋放"