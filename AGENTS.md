# AGENTS.md — stories 仓库工作约定

## 仓库结构（monorepo，2026-09-13 由 stories + stories_android 合并）

`~/stories` = **后端 + 数据服务 + 两个前端**：

```
~/stories/
├── scraper/          # 后端核心：知乎/B站抓取、AI 打标、画像引擎（profile-engine）、排序器（ranker）、定时调度
├── deploy/           # nginx（JWT 认证）+ 行为上报/画像 API（api.mjs / start-api.sh）
├── public/data/      # 时间线 JSON、recommendations.json、APK 更新发布目录（public/data/app/）
├── scripts/          # sync-zhihu / sync-bilibili（抓取产物 → public/data）
├── web/              # web UI —— 已冻结，只做浏览器兜底入口（Vite/React）
├── mobile/           # 主力前端：Expo/RN Android App（CI 自动打包 APK）
└── docs/design.md
```

根 `package.json` 的 scripts 是数据管道入口（scrape/sync/tag/profile/rank/api/schedule），
`dev/build/preview` 代理到 `web/`（`npm run build --prefix web` 等价）。后端代码全部用
`import.meta.dirname` 相对路径定位 `scraper/`、`public/data/`，**这些目录必须留在仓库根**。

## 主力前端是 mobile/（重要）

**95% 以上的使用发生在 Android APK（`mobile/`，Expo/RN）上，web UI 基本不再使用。** 因此：

1. **所有新功能一律做在 `mobile/`**，不要再给 web UI 加功能；web 只在致命 bug 影响兜底可用时才修。
2. 两个前端不共享代码：`mobile/src/api/normalize.ts`、`mobile/src/types.ts`、`mobile/src/api/feedback.ts` 等是从 web 端**手工移植的镜像副本**。凡改动后端契约——
   - `/data/*.json` 的数据结构（新增数据源、字段变更）
   - `scraper/event-store.mjs` 的事件语义（kind/权重/字段）
   - `/api/profile`、`/api/verdicts` 的返回结构
   - `scraper/ranker.mjs` 生成的 recommendations.json 结构

   **必须同步检查并更新 `mobile/src/` 里的对应镜像文件**，否则 APK 会静默丢数据（多字段无害，少字段/改字段会）。
3. web 端保留可构建（`npm run build`），作为没装 APK 时的浏览器入口即可，不作为功能对齐目标。
4. APK 的构建、版本发布、更新分发流程见 **`mobile/AGENTS.md`**（GitHub Actions 打包 → 拉取 artifact → `mobile/scripts/publish-apk.sh` 发布到本仓库 `public/data/app/`）。

## 后端改动注意事项（与 APK 相关）

- `/api/events` 由 nginx JWT 层保护：web 靠 cookie（`jovijwt`），APK 靠 `Authorization: Bearer`，两边都要能通，改认证逻辑时两条路径都要验证。
- 画像/排序是定时批处理（scheduler 每 15 分钟一轮），前端（尤其 APK）读到的 recommendations.json 有最多一轮的延迟，属正常现象。
- 删除或重命名 `public/data/` 下任何 JSON 前，先确认 `mobile/src/api/sources.ts` 的 SOURCES 注册表不再引用。
- 生产容器 `stories-nginx` 的 bind mount 指向 `web/dist` 与 `public/data`；移动这两个目录后必须重建容器。

## 调度器由 systemd user 单元托管（重启别用 npm）

生产上的抓取调度器由 **systemd user 单元 `stories-scheduler.service`** 托管
（`~/.config/systemd/user/stories-scheduler.service`，`Restart=always` + `RestartSec=10`，
`ExecStart=node scraper/scheduler.mjs`，节奏环境变量 `SCRAPE_INTERVAL_MINUTES=15`、
`OUTPUT_KEEP_DAYS=7` 都配在单元里，不走 shell 环境）。

1. **重启/停止一律用 `systemctl --user restart|stop|start stories-scheduler`**，
   状态看 `systemctl --user status stories-scheduler`。**不要用 `npm run schedule:stop/start`**：
   那会杀死 systemd 管理的主进程，systemd 陷入每 10 秒拉起一次的 auto-restart 循环，
   而每次拉起的实例都会被 pid 文件双实例守卫顶掉退出——日志
   （`scraper/logs/scheduler.log`）被「已有调度器在运行，本实例退出」刷屏，
   单元永远卡在 `activating auto-restart`，实际运行的却是那个游离的 npm 守护（2026-09-19 实际踩过）。
2. 改了 `scraper/scheduler.mjs` 后必须 `systemctl --user restart stories-scheduler` 才生效：
   守护进程常驻内存，per-source 抓取脚本是每轮按路径现拉的，但调度逻辑本身（哪轮抓什么）是启动时加载的。
3. 守护启动即抓一轮（`lastScrape` 初始为 0），所以任何一次重启都会立即跑一整轮
   知乎/B站/GitHub 抓取，属正常现象，重启前留意别撞上正在进行的上一轮（看日志确认「本轮抓取完成 ✓」）。
