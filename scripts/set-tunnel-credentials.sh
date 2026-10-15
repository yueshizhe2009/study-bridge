#!/usr/bin/env bash
# Write Study Bridge's own tunnel credentials to ~/.config/study-bridge/tunnel.env (mode 600).
#
# Prompts with hidden input so the runtime key never lands in shell history or a process list.
# The file is read by the app; it is never written to by the app, and it never touches
# ~/.config/webcodex/tunnel.env or any WebCodex file.
set -euo pipefail

CONFIG_DIR="${STUDY_BRIDGE_CONFIG_DIR:-$HOME/.config/study-bridge}"
TARGET="$CONFIG_DIR/tunnel.env"

printf 'Tunnel ID (tunnel_...): '
read -r TUNNEL_ID
printf 'Runtime API key (input hidden): '
read -rs API_KEY
printf '\n'

if [[ ! "$TUNNEL_ID" =~ ^tunnel_[A-Za-z0-9]+$ ]]; then
  echo "error: tunnel id should look like tunnel_XXXXXXXX" >&2
  exit 1
fi

if [[ -z "$API_KEY" ]]; then
  echo "error: runtime key is empty" >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR"
umask 077                       # create the file unreadable to others from the start
cat > "$TARGET" <<EOF
CONTROL_PLANE_TUNNEL_ID=$TUNNEL_ID
CONTROL_PLANE_API_KEY=$API_KEY
EOF
chmod 600 "$TARGET"

echo "wrote $TARGET (mode $(stat -c '%a' "$TARGET"))"
echo
echo "next:"
echo "  1. 应用里点「启动」（或跑下面这条验证 tunnel 能否起来）"
echo "     cd ~/study-bridge && node scripts/supervisor-smoke.js"
echo "     期望: state=ready 且 credentialSource=own"
echo "  2. 在 https://chatgpt.com/#settings/Connectors 新建 connector 指向新 tunnel"
echo "     （必须在 tunnel-client 运行期间创建/校验）"
