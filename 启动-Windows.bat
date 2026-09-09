@echo off
chcp 65001 >nul
REM 双击启动「局域网提审与交付工具」（Windows 创作者主机）
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 Node.js，程序无法启动。
  echo   请打开 https://nodejs.org/zh-cn/ 下载左边那个 LTS 版本，
  echo   一路点“继续”安装完成后，再重新双击本文件。
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%a in ('node -p "process.versions.node"') do set NODEMAJOR=%%a
for /f "tokens=2 delims=." %%a in ('node -p "process.versions.node"') do set NODEMINOR=%%a
if "%NODEMAJOR%"=="22" if "%NODEMINOR%" LSS "5" set NODEOLD=1
if %NODEMAJOR% LSS 22 set NODEOLD=1
if defined NODEOLD (
  echo.
  echo   Node.js 版本过低，需要 22.5 以上。
  echo   请到 https://nodejs.org/zh-cn/ 下载 LTS 版本覆盖安装后重试。
  echo.
  pause
  exit /b 1
)

echo   正在启动 LAN Review...浏览器会自动打开创作者页面。
echo   关闭本窗口即停止程序；手机正在审核时请先别关。
echo.
node server\index.js
if errorlevel 1 (
  echo.
  echo   程序退出了，请把上面的提示截图反馈。
  pause
)
