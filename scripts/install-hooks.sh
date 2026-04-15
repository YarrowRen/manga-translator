#!/usr/bin/env bash
# 安装 git pre-push hook
# 每次 git push 前自动将本地 deploy/presets.json 同步到 GitHub Secret
#
# 前置条件：
#   brew install gh
#   gh auth login
#
# 用法：bash scripts/install-hooks.sh

set -euo pipefail

HOOK_FILE=".git/hooks/pre-push"

cat > "$HOOK_FILE" << 'EOF'
#!/usr/bin/env bash
PRESETS="deploy/presets.json"
if [ -f "$PRESETS" ]; then
  if command -v gh &>/dev/null; then
    echo "[hook] 同步 $PRESETS → GitHub Secret PRESETS_JSON"
    gh secret set PRESETS_JSON --body "$(cat "$PRESETS")"
  else
    echo "[hook] 警告: gh CLI 未安装，跳过 Secret 同步（brew install gh）"
  fi
fi
EOF

chmod +x "$HOOK_FILE"
echo "✓ pre-push hook 已安装：$HOOK_FILE"
echo "  每次 git push 前会自动同步 deploy/presets.json → GitHub Secret"
