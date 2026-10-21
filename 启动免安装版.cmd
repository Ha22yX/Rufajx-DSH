@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
set "RUFA_DIR=%~dp0build\Rufa-DSH"
set "RUFA_APP="
for %%F in ("%RUFA_DIR%\*.exe") do if exist "%%~fF" set "RUFA_APP=%%~fF"
if not defined RUFA_APP (
  echo Portable build not found in "%RUFA_DIR%"
  pause
  exit /b 1
)
start "" /D "%RUFA_DIR%" "%RUFA_APP%"
