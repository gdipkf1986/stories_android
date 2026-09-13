#!/usr/bin/env bash
# 把 apk/ 里最新的 artifact APK 发布到 stories 后端（~/stories/public/data/app/），
# 生成 latest.json 供 App 内「检查更新」使用。
# 调用时机：AGENTS.md 里那个 gh 拉取 artifact 的延时任务的最后一步。
# 约定：APK 文件名 stories-v{版本}-arm64-r{构建号}.apk（CI 产物命名）；原子写 + 权限对齐 stories 约定。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT/apk"
DEST_DIR="$HOME/stories/public/data/app"

APK=$(ls -t "$SRC_DIR"/*.apk 2>/dev/null | head -1)
[ -n "$APK" ] || { echo "[publish-apk] apk/ 里没有 APK，先跑 gh 拉取流程"; exit 1; }
NAME=$(basename "$APK")

if [[ $NAME =~ ^stories-v([0-9.]+)-arm64-r([0-9]+)\.apk$ ]]; then
  VER="${BASH_REMATCH[1]}"
  CODE="${BASH_REMATCH[2]}"
else
  echo "[publish-apk] 文件名不符合 stories-v{ver}-arm64-r{code}.apk 约定: $NAME"
  exit 1
fi

mkdir -p "$DEST_DIR"
# 只保留最新：清掉目录里其他 APK
find "$DEST_DIR" -maxdepth 1 -name '*.apk' ! -name "$NAME" -delete
cp -f "$APK" "$DEST_DIR/$NAME"

SIZE=$(stat -c%s "$APK")
SHA=$(sha256sum "$APK" | cut -d' ' -f1)
TMP="$DEST_DIR/.latest.json.tmp"
cat > "$TMP" <<EOF
{
  "version": "$VER",
  "versionCode": $CODE,
  "fileName": "$NAME",
  "sizeBytes": $SIZE,
  "sha256": "$SHA",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "url": "/data/app/$NAME"
}
EOF
mv "$TMP" "$DEST_DIR/latest.json"
chmod 644 "$DEST_DIR/latest.json" "$DEST_DIR/$NAME"

echo "[publish-apk] 已发布 $NAME（v$VER，versionCode $CODE，$SIZE 字节）→ $DEST_DIR"
