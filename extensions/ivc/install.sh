#!/usr/bin/env bash
# Install the IVC channel plugin into the local OpenClaw installation.
#
# This script copies the extension files into OpenClaw's extensions directory
# and links the package so OpenClaw can discover and load it.
#
# Usage: ./install.sh
# Run from the extensions/ivc/ directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Find OpenClaw installation
OPENCLAW_BIN="$(which openclaw 2>/dev/null || true)"
if [ -z "$OPENCLAW_BIN" ]; then
  echo "ERROR: openclaw not found in PATH"
  exit 1
fi

OPENCLAW_BIN_REAL="$(readlink -f "$OPENCLAW_BIN")"
OPENCLAW_PKG="$(dirname "$OPENCLAW_BIN_REAL")/../lib/node_modules/openclaw"

if [ ! -d "$OPENCLAW_PKG" ]; then
  echo "ERROR: OpenClaw package not found at $OPENCLAW_PKG"
  exit 1
fi

IVC_EXT_DIR="$OPENCLAW_PKG/extensions/ivc"
echo "OpenClaw package: $OPENCLAW_PKG"
echo "IVC extension target: $IVC_EXT_DIR"

# Create extension directory
mkdir -p "$IVC_EXT_DIR/src"

# Copy files
echo "  -> Copying plugin files"
cp "$SCRIPT_DIR/package.json" "$IVC_EXT_DIR/"
cp "$SCRIPT_DIR/openclaw.plugin.json" "$IVC_EXT_DIR/"
cp "$SCRIPT_DIR/index.ts" "$IVC_EXT_DIR/"
cp "$SCRIPT_DIR/src/runtime.ts" "$IVC_EXT_DIR/src/"
cp "$SCRIPT_DIR/src/config.ts" "$IVC_EXT_DIR/src/"
cp "$SCRIPT_DIR/src/channel.ts" "$IVC_EXT_DIR/src/"
cp "$SCRIPT_DIR/src/gateway.ts" "$IVC_EXT_DIR/src/"
cp "$SCRIPT_DIR/src/inbound.ts" "$IVC_EXT_DIR/src/"

echo ""
echo "IVC channel plugin installed successfully."
echo ""
echo "Add this to ~/.openclaw/openclaw.json under channels:"
echo '  "ivc": {'
echo '    "enabled": true,'
echo '    "targetSession": "discord:channel:1482740936210382980",'
echo '    "listenPort": 54322,'
echo '    "listenHost": "127.0.0.1",'
echo '    "ttsEnabled": true,'
echo '    "masterControllerUrl": "http://192.168.5.81:54321"'
echo '  }'
echo ""
echo "Then restart OpenClaw for changes to take effect."
