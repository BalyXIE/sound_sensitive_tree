@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo 未检测到 Node.js。请先安装: https://nodejs.org/
  pause
  exit /b 1
)

echo 正在启动本地网页服务（不要关闭新弹出的黑色窗口）…
start "Sound tree server" cmd /k "cd /d %~dp0 && node static-server.mjs"

timeout /t 2 /nobreak >nul
start http://127.0.0.1:8765/

echo 若浏览器显示无法连接，请等 2 秒后按 F5 刷新，或改用: http://localhost:8765/
pause
