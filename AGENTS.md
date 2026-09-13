# 项目定位：stories 的主力前端

本仓库（Expo/RN APK）是 stories 项目的**主力前端，95%+ 的使用都在这里**；`~/stories` 里的
web UI 已冻结，只做浏览器兜底。新功能一律做在本仓库。注意：

- `~/stories` 是后端（抓取/调度/API/认证/APK 分发），两端约定详见 `~/stories/AGENTS.md`
- `src/api/normalize.ts`、`src/types.ts`、`src/api/feedback.ts`、`src/api/recommendations.ts`
  等是从 web 端移植的**镜像副本**（不共享代码）：后端改了 `/data/*.json` 结构、
  事件语义（kind/权重）或 `/api/profile`、`recommendations.json` 结构时，必须同步更新这里的对应文件
- 反馈链路：喜欢/不感兴趣/点开原文 → `src/api/feedback.ts` 批量补发 `POST /api/events`；
  点开过的条目本地隐藏（`stories.hidden-items`），信息流不再显示

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

