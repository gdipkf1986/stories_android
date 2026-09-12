# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# APK 构建产物拉取

每次推送到远程 GitHub 会自动触发 APK 的 Build（GitHub Actions，约 10 分钟）：推送后要设置一个 **20 分钟后的延时任务**（如 `sleep 1200 && …` 交给后台执行），用 `gh` 拉取该次 build 的 artifact（gh 在 `~/.local/bin`，未登录时先 `gh auth login`），本地 `apk/` 目录**只保留最新一个版本的 artifact APK**——延时任务里先删掉旧 APK 再下载新的。**必须走 clash 代理**（`https_proxy=http://127.0.0.1:7890`），否则 artifact 下载会直连卡死（API 调用没事，下载大文件必挂）：

```bash
sleep 1200; cd ~/stories_android; \
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890; \
RUN_ID=$(gh run list --workflow=build-apk.yml --limit 1 --json databaseId -q '.[0].databaseId'); \
gh run watch "$RUN_ID" --exit-status && \
gh run download "$RUN_ID" --name stories-apk --dir apk/.dl && \
find apk -maxdepth 1 -name '*.apk' -delete && \
mv apk/.dl/*.apk apk/ && rm -rf apk/.dl && \
bash scripts/publish-apk.sh
```

最后一步 `scripts/publish-apk.sh` 把新 APK 发布到 stories 后端（`~/stories/public/data/app/` +
原子写 `latest.json`），App 内的更新检查（`src/api/update.ts`，启动时静默查、横幅提示下载安装）
就能发现新版本。别漏掉这一步，否则手机端永远提示不出更新。

