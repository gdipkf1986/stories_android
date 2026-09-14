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

# ⚠️ 推送前必须向用户确认（构建有成本）

推送到远程 main 会自动触发 GitHub Actions APK 构建，**每次构建都有成本，不要擅自触发**。
因此：

- **任何会触发构建的 push（推 main、推 tag）之前，必须先向用户确认**，得到明确同意后再推。
- 纯本地工作不受限：改代码、`tsc` 检查、本地 commit 随便做，攒到用户确认后一起推。
- 用户明确要求「提交并推送 / 发布新 APK」时视为已确认，不必再问一遍。

# 版本管理（全自动，不要手动 bump）

版本号由 CI 在 **build 成功之后**自动流转，人不再手动改 `app.json`：

1. 开发者把功能代码 push 到 main（**不动版本号**；push 前先 `git pull --rebase`，
   main 上可能有 CI bot 的版本 bump commit；**push 会触发构建，先按上面「推送前必须
   向用户确认」拿到同意**）
2. Actions 构建：`versionCode` 在构建时注入 = CI run number（每次构建必增，可覆盖安装）；
   `versionName` 用 app.json 里当时的 `expo.version`
3. build 成功后 CI 自动：
   - 打 tag **`v{version}-r{run_number}`**（与 artifact 文件名对齐）并推送；
     tag push 会再触发一次构建，把 APK 挂到对应的 GitHub Release
   - bump `app.json` 的 patch 版本（如 1.5.0 → 1.5.1）commit 回 main
     （commit message 带 `[skip ci]` 防循环构建）
4. 所以下一次构建天然带新版本号，永不重版；若 Tag & bump 步骤失败（构建期间恰有
   并发推送 rebase 冲突等），artifact 已上传不受影响，本地重跑 `workflow_dispatch` 即可

# APK 构建产物拉取

每次推送到远程 GitHub 会自动触发 APK 的 Build（GitHub Actions，约 10 分钟；**推送本身必须先经
用户确认，见上文「⚠️ 推送前必须向用户确认」**）：确认推送后，拉取/发布这套后续流程就自动走完，
不再逐条询问。推送后要设置一个 **20 分钟后的延时任务**（如 `sleep 1200 && …` 交给后台执行），用 `gh` 拉取该次 build 的 artifact（gh 在 `~/.local/bin`，未登录时先 `gh auth login`），本地 `apk/` 目录**只保留最新一个版本的 artifact APK**——延时任务里先删掉旧 APK 再下载新的。**必须走 clash 代理**（`https_proxy=http://127.0.0.1:7890`），否则 artifact 下载会直连卡死（API 调用没事，下载大文件必挂）：

```bash
export PATH="$HOME/.local/bin:$PATH";  # gh 不在默认 PATH 里，漏了这行延时任务会 command not found
sleep 1200; cd ~/stories/mobile; \
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

