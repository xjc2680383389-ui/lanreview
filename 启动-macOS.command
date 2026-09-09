#!/bin/bash
# 双击启动「局域网提审与交付工具」（macOS 创作者主机）
# 这是给普通用户用的入口：不需要终端、不需要改配置。
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  没有找到 Node.js，程序无法启动。"
  echo "  请打开 https://nodejs.org/zh-cn/ 下载左边那个 LTS 版本，"
  echo "  一路点「继续」安装完成后，再重新双击本文件。"
  echo ""
  read -r -p "按回车键关闭这个窗口…" _
  exit 1
fi

VERSION=$(node -e "const [M,m]=process.versions.node.split('.').map(Number);console.log(M>22||(M===22&&m>=5)?1:0)" 2>/dev/null)
if [ "$VERSION" != "1" ]; then
  echo ""
  echo "  Node.js 版本过低（当前 $(node -v)），需要 22.5 以上才能启动。"
  echo "  请到 https://nodejs.org/zh-cn/ 下载 LTS 版本覆盖安装后重试。"
  echo ""
  read -r -p "按回车键关闭这个窗口…" _
  exit 1
fi

echo "  正在启动 LAN Review…浏览器会自动打开创作者页面。"
echo "  关闭这个窗口即停止程序；手机正在审核时请先别关。"
echo ""
node server/index.js
STATUS=$?
if [ $STATUS -ne 0 ]; then
  echo ""
  echo "  程序退出了（代码 $STATUS）。请把上面的提示截图反馈。"
  read -r -p "按回车键关闭这个窗口…" _
fi
