@echo off
setlocal
REM free-pi-cli-proxy persistent launcher (logs warnings and above).
REM Prefers Bun for performance; falls back to Node.js when Bun is missing.
REM Keep this file ASCII-only: cmd.exe reads .bat as ANSI and mangles UTF-8 text.
cd /d "%~dp0"
if not exist logs mkdir logs
set LOG_LEVEL=warn
if not defined PROXY_PORT set PROXY_PORT=6447

REM Rotate the log once it exceeds 10 MB so a long-running proxy cannot fill the disk.
for %%F in (logs\proxy.log) do if %%~zF GTR 10485760 move /y "logs\proxy.log" "logs\proxy.log.1" >nul

set "BUN_CMD="
where bun >nul 2>nul && set "BUN_CMD=bun"
if not defined BUN_CMD if exist "%USERPROFILE%\.bun\bin\bun.exe" set "BUN_CMD=%USERPROFILE%\.bun\bin\bun.exe"
if not defined BUN_CMD set "BUN_CMD=node"

:run
"%BUN_CMD%" server.mjs >> logs\proxy.log 2>&1
echo [WARN] proxy exited with code %errorlevel%; restarting in 5s...
REM "timeout" fails when stdin is redirected; ping is a portable delay.
ping -n 6 127.0.0.1 >nul 2>&1
goto run
