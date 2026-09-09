#!/bin/bash
# 双击启动「局域网提审与交付工具」（Linux 创作者主机）
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "  没有找到 Node.js，请先安装 22.5 以上版本（https://nodejs.org/zh-cn/）。"
  read -r -p "按回车键关闭…" _
  exit 1
fi

echo "  正在启动 LAN Review…"
node server/index.js
read -r -p "程序已退出，按回车键关闭…" _
