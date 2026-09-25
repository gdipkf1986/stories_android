#!/usr/bin/env bash
# 常驻对账 GitHub Release：每 10 分钟由 systemd timer 触发，发现比本地 latest 更新的 APK 就下载发布。
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APK_DIR="$MOBILE_DIR/apk"
LATEST_FILE="$HOME/stories/public/data/app/latest.json"
CURRENT_TAG=""
CURRENT_FILE=""

if [[ -f "$LATEST_FILE" ]]; then
  CURRENT_FILE=$(node -e "const p=require(process.argv[1]);console.log(p.fileName ?? '')" "$LATEST_FILE")
  if [[ $CURRENT_FILE =~ ^stories-v([^-]+)-arm64-r([0-9]+)\.apk$ ]]; then
    CURRENT_TAG="v${BASH_REMATCH[1]}-r${BASH_REMATCH[2]}"
  fi
fi

LATEST_TAG=$(gh release view --json tagName -q .tagName)
if [[ -n "$CURRENT_TAG" && "$LATEST_TAG" == "$CURRENT_TAG" && -f "$APK_DIR/$CURRENT_FILE" ]]; then
  echo "[apk-release] 已是最新：$CURRENT_TAG"
  exit 0
fi

DOWNLOAD_DIR="$APK_DIR/.download"
rm -rf "$DOWNLOAD_DIR"
mkdir -p "$DOWNLOAD_DIR"
trap 'rm -rf "$DOWNLOAD_DIR"' EXIT

gh release download "$LATEST_TAG" --pattern '*.apk' --dir "$DOWNLOAD_DIR" --clobber
APK=$(find "$DOWNLOAD_DIR" -maxdepth 1 -type f -name '*.apk' -print -quit)
[ -n "$APK" ] || { echo "[apk-release] Release $LATEST_TAG 没有 APK 资产"; exit 1; }

find "$APK_DIR" -maxdepth 1 -type f -name '*.apk' -delete
mv "$APK" "$APK_DIR/"
bash "$MOBILE_DIR/scripts/publish-apk.sh"
echo "[apk-release] 已同步 $LATEST_TAG"
