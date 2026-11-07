@echo off
setlocal
REM free-pi-cli-proxy 常駐啟動腳本（日常值守：只顯示警告以上）
REM 推薦用 Bun 執行（效能與 fetch 行為與參考專案一致），找不到退回 Node.js
cd /d "%~dp0"
if not exist logs mkdir logs
set LOG_LEVEL=warn
if not defined PROXY_PORT set PROXY_PORT=6447

REM 單檔 log 超過 10MB 時輪替一次，避免長期常駐把磁碟寫滿。
for %%F in (logs\proxy.log) do if %%~zF GTR 10485760 move /y "logs\proxy.log" "logs\proxy.log.1" >nul

set "BUN_CMD=bun"
where bun >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.bun\bin\bun.exe" (
    set "BUN_CMD="%USERPROFILE%\.bun\bin\bun.exe""
  ) else (
    echo [WARN] 找不到 bun，退回 Node.js 執行。
    echo         建議安裝 Bun 以獲得最佳效能：powershell -c "irm bun.sh/install.ps1 | iex"
    set "BUN_CMD=node"
  )
)

:run
%BUN_CMD% server.mjs >> logs\proxy.log 2>&1
echo [WARN] proxy exited with code %errorlevel%; restarting in 5s...
timeout /t 5 /nobreak >nul
goto run