@ECHO off
REM cli-launcher shim (cmd, PowerShell) -- see ..\cli-launcher.js.
REM Runs with the editor's own runtime (CLI_LAUNCHER_NODE), so no Node install is needed.
SETLOCAL
SET "ELECTRON_RUN_AS_NODE=1"
SET "_CLI_LAUNCHER_RUNTIME=%CLI_LAUNCHER_NODE%"
IF NOT DEFINED _CLI_LAUNCHER_RUNTIME SET "_CLI_LAUNCHER_RUNTIME=node"
"%_CLI_LAUNCHER_RUNTIME%" "%~dp0..\cli-launcher.js" %*
EXIT /B %ERRORLEVEL%
