# stories

多 JSON 数据源聚合的知乎风格时间线。**Monorepo**：根目录是后端 + 数据服务（抓取/打标/画像/推荐/API），`web/` 是已冻结的 web 前端（TypeScript + React + Vite），`mobile/` 是主力前端（Expo/RN Android App，见 [mobile/README.md](mobile/README.md)）。

> 2026-09-13 由 `~/stories`（web）与 `~/stories_android`（App）合并而来；git 历史沿用 stories_android 仓库。

> 本项目由 `~/zhihu-scraper/` 合并而来：抓取器代码现位于 `scraper/`，登录态已迁移，
> 原目录保留作回退数据源，确认稳定后可删除。

## 快速开始

```bash
npm install
npm run scrape      # 手动抓取一次知乎并同步到前端（可选）
npm run tag:zhihu   # 为知乎条目 AI 打分类标签（幂等，只处理无标签条目）
npm run dev         # 开发服务器 http://localhost:5173（开发用）
npm run build       # 类型检查 + 产出 dist/
npm run preview     # 预览构建产物
```

## 生产部署（nginx docker，端口 20001，含 JWT 认证）

`stories-nginx` 容器托管生产构建 + 登录认证，数据目录 bind mount 实时生效：

```bash
npm run build       # 构建产物到 dist/
docker rm -f stories-nginx 2>/dev/null; docker run -d --name stories-nginx --restart unless-stopped \
  -p 20001:20001 \
  -v ~/stories/deploy/nginx.conf:/etc/nginx/nginx.conf:ro \
  -v ~/stories/deploy/auth.js:/etc/nginx/auth.js:ro \
  -v ~/stories/deploy/login.html:/usr/share/nginx-login/login.html:ro \
  -v ~/stories/web/dist:/usr/share/nginx/html:ro \
  -v ~/stories/public/data:/usr/share/nginx/html/data:ro \
  --env-file ~/stories/deploy/auth.env \
  nginx:alpine
```

- 访问入口：`https://www.johuh.dpdns.org`（浏览器未登录会 302 到 `/login`）
- **认证**：`Authorization: Bearer <jwt>` 或 Cookie `jovijwt` 任一存在即校验（HS256），缺失/无效一律 401；`POST /auth/login` 用访问密码换 token（30 天有效，6次/分钟限速防爆破）
- **密钥与口令**：`deploy/auth.env`（`JWT_SECRET` / `AUTH_PASSWORD`，chmod 600，不进 git）；轮换密钥后所有旧 token 立即失效，重新登录即可
- **更新数据**（免重建）：`npm run scrape` 或 `npm run sync:zhihu` 后即时生效
- **更新前端代码**：`npm run build`；若容器内出现 404/403，`docker restart stories-nginx`
- 缓存策略：`/assets/*` 长缓存（`private` 防止 Cloudflare 边缘缓存受保护内容），`/data/*` no-cache，JSON 开启 gzip
- `build` / `sync:zhihu` 脚本已内置 `chmod -R a+rX`：NAS 家目录权限保护会让容器内进程读不到新文件，务必通过 npm scripts 执行
- 移除服务：`docker rm -f stories-nginx`

## 每日定时抓取

定时方式二选一（都是每 15 分钟一轮，每轮自动 同步 → 打标 → 画像 → 排序）：

**方式 A：Node 守护进程**（SSH 进 NAS 跑一次；NAS 重启后需重新执行）

```bash
npm run schedule:start   # 默认每 15 分钟抓取一次，启动时先抓一次
npm run schedule:stop    # 停止
npm run schedule         # 前台运行（观察日志用）
SCRAPE_INTERVAL_MINUTES="30" npm run schedule:start   # 改成每 30 分钟（≥5，0 切回每日模式）
SCRAPE_INTERVAL_MINUTES="0" SCRAPE_TIME="22:30" npm run schedule:start   # 每日定时模式
```

**方式 B：crontab 单次模式**（重启免维护，推荐；`--once` 自带节流，重复触发会自动跳过）

```bash
crontab -e   # 加一行：
*/15 * * * * cd /home/gdipkf1986/stories && /home/gdipkf1986/.nvm/versions/node/v24.13.0/bin/node scraper/scheduler.mjs --once >> scraper/logs/scheduler.log 2>&1
```

- 日志：`scraper/logs/scheduler.log`（含每次抓取结果与失败原因）
- 进程：`scraper/scheduler.pid`（守护模式防重复启动）；`--once` 的节流状态在 `scraper/storage/scheduler-state.json`
- 抓取失败通常是登录态过期 → 运行 `npm run scrape:login` 扫码重新登录

## 扫码登录的浏览器后端

登录脚本支持两种后端（抓取主链路固定 chromium）：

```bash
npm run scrape:login                  # 默认：Playwright 自带 chromium
npm run scrape:login:lightpanda      # Lightpanda 浏览器（docker）
ZHIHU_CDP_URL=http://host:9222 npm run scrape:login:lightpanda   # 连已运行的 Lightpanda
```

Lightpanda 模式（`scraper/login-qr-png.mjs --browser lightpanda`）：

- CDP 不可达时会自动 `docker run lightpanda/browser` 容器（需本机 docker），用完可 `docker rm -f lightpanda`
- 登录态经 `addCookies` 导入、`storageState` 落盘，与 chromium 模式产出的 `storage/zhihu-state.json` **完全通用**
- 注意 Lightpanda 的坑：`addCookies` 前必须先有活动页面，否则报 `BrowserContextNotLoaded`（脚本已处理）
- 实测结论（nightly 1.0.0，本机 Debian 12 / aarch64，glibc 2.36 跑不了原生二进制，走 docker）：
  - ✅ 登录页加载、二维码截图、cookie 导入/导出全部可用
  - ⚠️ 抓取主链路仅部分可用：推荐流 API 拦截 ✅、热榜 DOM 提取 ❌（`.HotItem` 渲染不出），故抓取仍用 chromium
  - 可随时复测：`node scraper/probe-lightpanda-scrape.mjs`（需先启动容器）

> **持久化提示**：调度器是常驻进程。在真实终端里运行即可长期生效（随系统重启消失，重启后再执行一次 `schedule:start`；需要开机自启可把该命令加入桌面自启或 shell 启动脚本）。在受限沙箱环境（如 AI 代理的工具沙箱）里进程无法跨会话存活，只能以会话内后台任务方式运行。

## 架构

```
scraper/zhihu-feed.mjs    ← Playwright 抓取知乎（推荐/关注/热榜）→ scraper/output/*.json
scraper/bilibili-feed.mjs ← Playwright 抓取 B站（热门/排行榜，无需登录）→ scraper/output/*.json
        │ 调度器每 15 分钟触发（scraper/scheduler.mjs，SCRAPE_INTERVAL_MINUTES 可调）
        ▼
scripts/sync-zhihu.mjs    ← 取最新输出拷贝到 public/data/zhihu-feed.json（并注入 AI 标签）
scripts/sync-bilibili.mjs ← 取最新输出拷贝到 public/data/bilibili-feed.json（并注入 AI 标签）
        │ 打标：scraper/tagger.mjs --source <zhihu|bilibili> 扫描无标签条目 → 智谱 glm-4-flash（免费）生成 2~4 个分类标签
        │ 标签持久化：scraper/storage/<source>-tags.json（按源分文件、按条目 id 索引，重新抓取不丢）
        ▼
web/src/data/sources.ts       ← 数据源注册表 + 并发加载（allSettled 容错）
web/src/data/normalize.ts     ← 每个源一个适配器，归一化成统一的 TimelineItem
        │
        ▼
web/src/types.ts              ← 统一时间线条目类型（UI 只认它）
        │
        ▼
web/src/components/*          ← 知乎风格 UI：来源筛选 / 最新·热门排序 / 卡片流
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run scrape` | 立即抓取一次（知乎 + B站）并同步到前端 |
| `npm run tag:zhihu` / `tag:bilibili` | AI 打分类标签（幂等，无标签的才调智谱 API，默认 glm-4-flash 免费） |
| `npm run scrape:login` | 知乎登录态过期时重新扫码（二维码存到 `scraper/storage/login-qr.png`） |
| `npm run scrape:login:lightpanda` | 用 Lightpanda 浏览器（docker）执行扫码登录 |
| `npm run schedule:start` / `schedule:stop` / `schedule` | 每日定时守护的启动 / 停止 / 前台运行 |
| `npm run sync:zhihu` / `sync:bilibili` | 只同步（不重新抓取） |
| `npm run dev` / `build` / `preview` | 前端开发 / 构建 / 预览 |

## 如何接入新的数据源

1. 在 `public/data/` 放一个新的 JSON 文件；
2. 在 `web/src/data/normalize.ts` 写一个适配函数，把它的字段映射成 `TimelineItem`，并注册进 `NORMALIZERS`；
3. 在 `web/src/data/sources.ts` 的 `SOURCES` 里加一条元信息（名称、动作描述、颜色、文件路径）。

完成。加载、容错、过滤、排序、UI 全部自动生效。

> **推荐系统侧也要接一行**：`scraper/sources.node.mjs` 的 `SOURCES_NODE` 加一条
> （file 相对 public/data/ + 一个轻量适配器，只映射 id/source/tags/title 等
> 排序字段，id 必须保持 `${source}:${原始id}` 与前端一致）。不加的话新源
> 能正常展示，但不会参与"为你推荐"排序。

## 画像与推荐（行为反馈排序）

借鉴 OpenBiliClaw 的分层思想做的轻量版：**行为事件 → 结构化偏好 → 排序**，
全部数据源无关，纯规则零 LLM 成本（LLM 人格画像是后续 P3）。

```
浏览器埋点（喜欢/不感兴趣/点击，web/src/lib/feedback.ts，批量 sendBeacon）
        ▼  POST /api/events（nginx JWT 认证后反代 → stories-api 容器）
scraper/storage/events.jsonl     ① 事件层：append-only，eid 去重，5MB 轮转
        ▼  npm run profile（幂等全量重算）
scraper/storage/profile.json     ② 偏好层：tag 权重（周衰减 0.9、<0.05 丢弃）、
        │                           避雷列表（容量 128）、来源/作者亲和、时段分布，
        │                           每个 tag 带证据事件 id；"显著变化"检测是 P3
        │                           LLM 画像重建的触发钩子
        ▼  npm run rank
public/data/recommendations.json ③ 推荐流：id+分数+理由的轻量文件，
                                    前端"为你推荐"tab 按 it 顺序渲染
```

- 打分公式：`相关性×0.30 + 时效×0.10 − 话题疲劳×0.25 − 来源单调×0.15 + 探索×0.20 + 作者加成`，
  再经 Jaccard-MMR 与 tag/来源硬配额打散（权重起步值移植自 OpenBiliClaw 的生产校准）
- **画像/标签只影响排序，人格描述永远不进打分**（P3 的 soul.json 仅展示+探针素材）
- 抓取每 `SCRAPE_INTERVAL_MINUTES`（默认 15）分钟一轮，每轮抓取后自动同步 + 打标 + 画像 + 排序，
  反馈延迟最多约 15 分钟；调度器另每 `RANK_HOURS`（默认 6）小时独立重排兜底
- 抓取产物自动清理：`output/` 只保留 `OUTPUT_KEEP_DAYS`（默认 7）天
- 手动验证：`npm run profile && npm run rank` 后刷新页面切「为你推荐」

### 画像分析页（前端查看 + 用户裁决）

Navbar 右上「画像」进入。展示四类分析结果：兴趣权重条形图、避雷、作者亲和、来源分布，
**每一条都可「确认 / 反对」**：

- 裁决独立持久化在 `scraper/storage/profile-verdicts.json`（`<type>:<名>` → confirmed/rejected），
  画像重算**永不覆盖**用户裁决；profile-engine 每次重算后把它作为覆盖层叠加
- 确认兴趣 tag → 权重托底 0.75（防衰减漂移）；反对 → 从兴趣画像移除
- 反对避雷 → 移出避雷列表；反对作者 → 其内容不再进入推荐流（ranker 直接排除）
- 「已反对的分析」区可一键撤销；徽标即时生效，权重变化在下一次 profile/rank 批后应用
- API：`GET /api/profile`（摘要+裁决状态）、`POST /api/verdicts {key, verdict}`

### 行为上报 API（deploy/api.mjs，docker 常驻）

```bash
npm run api:start        # 创建 stories-net 网络、接入 stories-nginx、启动 stories-api 容器
docker logs stories-api  # 看日志
npm run api:dev          # 本机裸跑（127.0.0.1:8787，配合 vite dev 的 /api 代理）
```

端点：`POST /api/events`（批量埋点，非法 kind/超长字段拒收）、`GET /api/profile`（画像摘要+裁决状态）、
`POST /api/verdicts`（用户裁决）、`GET /api/health`。nginx 对 `/api/` 同样强制 JWT 认证；
API 本身不做鉴权（仅内网可达）。


## 目录说明

| 路径 | 说明 |
| --- | --- |
| `scraper/zhihu-feed.mjs` | Playwright 抓取脚本（推荐/关注/热榜，API 拦截 + DOM 提取） |
| `scraper/scheduler.mjs` | 定时调度器（cron 替代，pid/日志管理；默认每 15 分钟抓取，抓取后自动打标，另有重扫/重排兜底和产物清理） |
| `scraper/tagger.mjs` | AI 自动打标：无标签条目 → 智谱 API（key 缺省读 `~/.config/opencode/opencode.jsonc`） |
| `scraper/tag-store.mjs` | 标签库读写与合并（`storage/zhihu-tags.json`，按条目 id 索引，重抓不丢） |
| `scraper/login-qr-png.mjs` | 扫码登录辅助（chromium / Lightpanda 双后端，自动拉起 docker 容器） |
| `scraper/test-lightpanda.mjs` | Lightpanda 连通性测试（CDP 连接 / 二维码 / cookie 往返） |
| `scraper/probe-lightpanda-scrape.mjs` | Lightpanda 抓取能力探测（API 拦截 / DOM 提取） |
| `scraper/storage/` | 知乎登录态（`zhihu-state.json`，含 cookie，勿提交仓库） |
| `scraper/output/` | 抓取原始输出（按时间戳命名，只增不删） |
| `public/data/zhihu-feed.json` | 数据源 0：知乎抓取（前端实际读取的副本） |
| `public/data/answers.json` | 数据源 1：知乎回答（嵌套 author 对象） |
| `public/data/news.json` | 数据源 2：科技资讯（扁平结构，字段名完全不同） |
| `public/data/blogs.json` | 数据源 3：博客专栏（顶层数组） |
| `scripts/sync-zhihu.mjs` | 抓取输出 → 静态目录 同步脚本 |
| `web/src/data/normalize.ts` | 归一化适配器 + 宽松字段防御（含知乎条目类型映射） |
| `web/src/data/sources.ts` | 数据源注册表、聚合加载、失败收集 |
| `web/src/utils/format.ts` | 万级数字 / 相对时间 / 热度分 |
| `web/src/utils/zhihu-app.ts` | 知乎 App 深链：手机上点标题/查看原文直接唤起知乎 App（Android intent 自动回落 / iOS scheme+超时回落 / 桌面不干预） |
| `web/src/components/` | Navbar、Sidebar、card/FeedCard（唯一条目卡片，与 mobile 端同一 CardModel 契约）、HotTopics |
| `mobile/` | 主力前端：Expo/RN Android App（构建/发布/更新分发见 mobile/README.md 与 mobile/AGENTS.md） |
| `docs/design.md` | 设计文档 |

> 旧的 `~/zhihu-scraper/` 是合并来源，确认新链路稳定后可自行归档删除；
> sync 脚本在项目内 `scraper/output/` 为空时会自动回退读它。
