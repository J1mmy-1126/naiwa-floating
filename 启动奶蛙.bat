@echo off
cd /d "%~dp0"
if exist "node_modules\electron\dist\electron.exe" goto run
echo [NaiWa] First run: installing Electron via China mirror ...
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
call npm install --registry=https://registry.npmmirror.com
:run
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit
