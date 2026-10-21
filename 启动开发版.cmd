@echo off
setlocal
set "RUFA_PWSH=pwsh"
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" set "RUFA_PWSH=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe"
"%RUFA_PWSH%" -NoLogo -NoProfile -File "%~dp0scripts\Start-Dev.ps1"
if errorlevel 1 pause
