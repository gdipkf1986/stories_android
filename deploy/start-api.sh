#!/usr/bin/env bash
# 启动 stories 行为上报 API 容器（deploy/api.mjs），并与 stories-nginx 同网络。
#
# 网络模型：自建 docker 网络 stories-net，nginx 与 API 容器都挂上去，
# nginx 用容器名 stories-api 直连（docker 内嵌 DNS），API 不发布任何宿主端口。
#
# 常用：
#   bash deploy/start-api.sh            # 启动/重启 API 容器
#   docker logs -f stories-api          # 看日志
#   bash deploy/start-api.sh --stop     # 停止
set -euo pipefail
cd "$(dirname "$0")/.."   # 项目根目录 ~/stories

NET="stories-net"
API_NAME="stories-api"
NGINX_NAME="stories-nginx"

if [[ "${1:-}" == "--stop" ]]; then
  docker rm -f "$API_NAME" 2>/dev/null || true
  echo "已停止 $API_NAME"
  exit 0
fi

docker network create "$NET" 2>/dev/null || true   # 已存在则忽略

# nginx 容器接入网络（已接入则忽略）；重启使新 nginx.conf（/api 反代）生效
if [ "$(docker inspect -f '{{.State.Running}}' "$NGINX_NAME" 2>/dev/null)" = "true" ]; then
  CONNECTED=$(docker inspect -f "{{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}} {{end}}" "$NGINX_NAME" | grep -c "$NET" || true)
  if [ "$CONNECTED" = "0" ]; then
    docker network connect "$NET" "$NGINX_NAME"
  fi
  docker restart "$NGINX_NAME"   # nginx.conf 挂载是 ro 的，重启加载 /api 反代
fi

docker rm -f "$API_NAME" 2>/dev/null || true
docker run -d --name "$API_NAME" \
  --network "$NET" \
  --restart unless-stopped \
  --user 1000:1000 \
  -e STORAGE_DIR=/app/storage \
  -e VERDICTS_FILE=/app/storage/profile-verdicts.json \
  -v ~/stories/scraper/storage:/app/storage \
  -v ~/stories/deploy/api.mjs:/app/api.mjs:ro \
  -v ~/stories/scraper/event-store.mjs:/scraper/event-store.mjs:ro \
  -v ~/stories/scraper/verdict-store.mjs:/scraper/verdict-store.mjs:ro \
  -v ~/stories/scraper/like-store.mjs:/scraper/like-store.mjs:ro \
  node:24-alpine \
  node /app/api.mjs

echo "已启动 $API_NAME（docker 内 8787，仅 nginx 可达）"
echo "验证：docker logs $API_NAME；curl 网页域名的 /api/health（需带登录态）"
