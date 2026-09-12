# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# APK 构建产物拉取

每次推送到远程 GitHub 会自动触发 APK 的 Build（GitHub Actions，约 10 分钟）：推送后要设置一个 **20 分钟后的延时任务**（如 `sleep 1200 && …` 交给后台执行），用 `gh` 拉取该次 build 的 artifact（`gh` 未安装/未登录时先装好并 `gh auth login`），本地 `apk/` 目录**只保留最新一个版本的 artifact APK**——延时任务里先删掉旧 APK 再下载新的：

```bash
sleep 1200; cd ~/stories_android; \
RUN_ID=$(gh run list --workflow=build-apk.yml --limit 1 --json databaseId -q '.[0].databaseId'); \
gh run watch "$RUN_ID" --exit-status && \
gh run download "$RUN_ID" --name stories-apk --dir apk/.dl && \
find apk -maxdepth 1 -name '*.apk' -delete && \
mv apk/.dl/*.apk apk/ && rm -rf apk/.dl
```

