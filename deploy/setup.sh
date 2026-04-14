#!/usr/bin/env bash
# deploy/setup.sh
# 在全新 Ubuntu 22.04 VPS 上执行一次，完成环境初始化
# 用法：bash setup.sh <github-repo-url>
# 示例：bash setup.sh https://github.com/yourname/manga-trans.git

set -euo pipefail

REPO_URL="${1:-}"
REPO_DIR="/opt/manga-trans"
WEB_ROOT="/var/www/manga-trans/dist"

if [[ -z "$REPO_URL" ]]; then
  echo "Usage: bash setup.sh <github-repo-url>"
  exit 1
fi

echo "==> [1/6] 配置 swap（2GB，防 build OOM）"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "swap 已创建"
else
  echo "swap 已存在，跳过"
fi

echo "==> [2/6] 安装系统依赖"
apt-get update -qq
apt-get install -y -qq git nginx

echo "==> [3/6] 安装 Node.js 20"
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
node --version
npm --version

echo "==> [4/6] 克隆仓库并构建"
if [[ ! -d "$REPO_DIR" ]]; then
  git clone "$REPO_URL" "$REPO_DIR"
else
  echo "仓库已存在，执行 pull"
  git -C "$REPO_DIR" pull
fi

mkdir -p "$WEB_ROOT"
cd "$REPO_DIR/app"
npm ci
npm run build
cp -r dist/. "$WEB_ROOT/"

echo "==> [5/6] 配置 nginx"
cp "$REPO_DIR/deploy/nginx.conf" /etc/nginx/sites-available/manga-trans
ln -sf /etc/nginx/sites-available/manga-trans /etc/nginx/sites-enabled/manga-trans
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

echo "==> [6/6] 配置 proxy 服务"
cp "$REPO_DIR/deploy/manga-trans-proxy.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now manga-trans-proxy

echo ""
echo "✓ 部署完成！"
echo "  访问地址：http://$(curl -sf https://ipinfo.io/ip 2>/dev/null || hostname -I | awk '{print $1}')"
echo ""
echo "后续更新："
echo "  1. 本地 git push"
echo "  2. GitHub Actions 自动完成其余步骤"
echo ""
echo "如果 ExHentai 无法直连，在 /etc/systemd/system/manga-trans-proxy.service"
echo "中取消注释 HTTPS_PROXY= 行，填入你的代理地址后执行："
echo "  systemctl daemon-reload && systemctl restart manga-trans-proxy"
