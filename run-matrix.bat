@echo off
REM One-click launcher for the undici version-matrix experiment.
REM See README.md for design rationale, runtime selection and outputs.

REM Uses whichever node is on PATH. Set NODE_EXE to a full path to override.
REM No user-specific or machine-specific path is baked into this file.
set SCRIPT=%~dp0run-matrix.cjs

if defined NODE_EXE (
  set "NODE=%NODE_EXE%"
) else (
  set "NODE=node"
)

where "%NODE%" >nul 2>nul
if errorlevel 1 (
  echo [error] Node.js not found: %NODE%
  echo         Install Node.js ^>= 20, or set NODE_EXE to a node.exe path and rerun.
  pause
  exit /b 1
)

echo Running undici version matrix...
"%NODE%" "%SCRIPT%" %*
echo.
echo Exit code: %ERRORLEVEL%
echo Results written to %~dp0results
pause
