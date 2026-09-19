# stories — 开发设计文档

> 本文档面向下一个开发会话：记录项目的全部关键信息、环境约束与踩坑记录。
> 最后更新：2026-09-12（新增 §12 画像与推荐）

## 1. 项目是什么

多 JSON 数据源聚合的**知乎风格时间线**网站。

- 技术栈：TypeScript + React 18 + Vite 5（严格模式 TS）
- 项目目录：`~/stories`（所有路径均相对此目录，下同）
- 两个入口：
  - 生产：`http://<主机IP>:20001`（nginx docker 托管，常驻）
  - 开发：`http://localhost:5173`（`npm run dev`，会话级，非持久）
- 前身：`~/zhihu-scraper/`（旧项目，仅作回退数据源，确认稳定后可删）

## 2. 数据流架构

```
scraper/zhihu-feed.mjs    Playwright 抓知乎（recommend/follow/hot 三流）
        │  每 15 分钟由 scraper/scheduler.mjs 调度（SCRAPE_INTERVAL_MINUTES，0=每日 SCRAPE_TIME 模式）
        ▼
scraper/output/*.json     原始抓取产物（按时间戳命名，只增不删）
        │  scripts/sync-zhihu.mjs 取最新一份拷贝（并合并注入 AI 标签，见下）
        ▼
public/data/zhihu-feed.json ──┐
public/data/answers.json      ├─ 四个数据源（结构刻意完全不同）
public/data/news.json         │
public/data/blogs.json     ───┘
        │  fetch（nginx 直接静态托管）
        ▼
src/data/sources.ts       数据源注册表 + Promise.allSettled 并发加载（单源挂掉不白屏）
src/data/normalize.ts     每源一个适配器 → 归一化成统一 TimelineItem（宽松字段防御）
        ▼
src/types.ts              TimelineItem / SourceId / SourceMeta / SortMode
        ▼
src/components/*          知乎风格 UI：Navbar / Sidebar(来源筛选) / card/FeedCard(唯一卡片) / HotTopics(热门榜)
src/App.tsx               最新/热门排序 + 来源过滤 + 加载/失败/空状态
```

**核心设计**：UI 只认 `TimelineItem`，任何源接入后自动获得容错/过滤/排序/展示全套能力。

**AI 自动打标（2026-09-12 新增）**：`scraper/tagger.mjs` 扫描 `public/data/zhihu-feed.json`，
对没有 `tags` 字段的条目调智谱 API 生成 2~4 个分类标签。

- 模型：默认 `glm-4-flash`（智谱**免费**模型；实测 glm-4.5-air 走标准端点 429 余额不足，
  coding 端点 `/api/coding/paas/v4` 虽通但会被路由到 glm-5.3-flash）
- key：缺省读 `~/.config/opencode/opencode.jsonc` 的 `provider.*.options.apiKey`（脚本内置
  JSONC 注释剥离），`ZHIPU_API_KEY` 环境变量可覆盖；模型/端点用 `ZHIPU_MODEL` / `ZHIPU_BASE_URL`
- **标签必须独立持久化**：`scraper/storage/zhihu-tags.json`（按条目原始 id 索引，已 gitignore）。
  抓取产物每次整份覆盖，标签写进数据文件会被下次 sync 冲掉；sync-zhihu.mjs 现在会在拷贝后
  自动从标签库合并注入
- 调度：默认每 `SCRAPE_INTERVAL_MINUTES`（15）分钟 抓取→同步→打标→画像→排序 一整轮（启动先抓一次）；
  守护进程另每 6 小时重扫未打标（`TAG_SCAN_HOURS`，0 关闭）；产物按 `OUTPUT_KEEP_DAYS`（默认 7 天）自动清理。
  15 分钟节奏下 SHOWN_CAP 提到 600（100 条只够记 1 小时，7 天去重会失效）。
  幂等：只处理无标签条目，个别失败下次自动重试
- 实测：70 条全量打标 30 秒（并发 3），零失败；手动跑 `npm run tag:zhihu`

## 3. 统一数据类型（src/types.ts）

```ts
type SourceId = 'zhihu' | 'answers' | 'news' | 'blogs' | 'bilibili';

interface TimelineItem {
  id: string;          // `${source}:${原始id}`，全局唯一
  source: SourceId;
  author: string;
  title: string;
  excerpt: string;
  createdAt: number;   // 毫秒时间戳（注意知乎抓取源是 Unix 秒，适配器里 *1000）
  metrics: Metric[];   // {label, value}[]，如 赞同/评论/阅读
  tags: string[];
  kind?: string;       // 每条动作文案（"回答了问题"），缺省用数据源级 kind
  url?: string;        // 原文链接（有则标题可点击）
  cover?: string;      // 封面图 URL（B站视频等有封面的条目），https
  feed?: string;       // 源内子板块（zhihu: recommend/follow/hot；bilibili: popular/rank/home）
}
```

知乎条目 type → kind/tag 映射（normalize.ts 的 `ZHIHU_KIND`）：
`answer→回答了问题/回答`、`article→发布了文章/文章`、`question→提出了问题/提问`、`pin→发布了想法/想法`、`hot→登上热榜/热榜`。
热榜条目**无时间戳**，createdAt 退化为快照时间（`scraped_at`）。跨流重复条目按 id 去重（实测 100 条去重后 99）。

## 4. 接入新数据源（3 步，卡片零改动）

1. `public/data/` 放新 JSON；
2. 适配器写两份镜像：`web/src/data/normalize.ts` + `mobile/src/api/normalize.ts`
   （参考现有适配器的宽松防御写法）并注册进各自的 `NORMALIZERS`；
3. 注册表各加一条：`web/src/data/sources.ts` / `mobile/src/api/sources.ts`
   的 `SOURCES` 加元信息 `{id, label, kind, color, file, feeds?, card?}`。

**卡片规范（一卡到底）**：所有数据源、所有子板块的条目一律由 `FeedCard` 渲染
（mobile `src/components/card/FeedCard.tsx` 为权威版，web `src/components/card/FeedCard.tsx`
是同一份 CardModel 契约的 DOM 镜像）。数据差异在适配器解决，长相差异只允许通过注册表的
`card: CardVisual`（封面比例、指标数）微调；**禁止为新源另写卡片组件**。
详见 `mobile/src/components/card/README.md`。

## 5. 抓取器（scraper/）

| 文件 | 说明 |
| --- | --- |
| `scraper/zhihu-feed.mjs` | 主抓取：recommend/follow 用 **API 拦截**（page.on('response')），hot 用 **DOM 提取**（.HotItem）。路径全部基于 `import.meta.dirname` 自定位。参数 `--tabs --screens --out` |
| `scraper/github-trending.mjs` | GitHub Trending 抓取：纯 HTTP 拉 HTML 按 `<article class="Box-row">` 解析（无需 Playwright/登录）。github.com 直连不通，默认走 clash 代理 `127.0.0.1:7890`（`GITHUB_PROXY=direct` 强制直连），代理失败自动回落直连。参数 `--tabs daily,weekly,monthly --out`；调度器侧默认 24h 一次（`GITHUB_INTERVAL_HOURS`） |
| `scraper/github-summarizer.mjs` | 为上榜仓库生成中文介绍：抓 README（优先 `README.zh-CN.md` 等中文命名变体，raw 探测 → 默认 README 走 api.github.com 兜底）→ 智谱 LLM 总结 ≤10 句 → 存 `storage/github-summaries.json`（幂等，README 原文缓存）→ 注入 `item.summary`（前端摘要优先展示）。`SUMMARY_LIMIT` 限量试跑 |
| `scraper/github-http.mjs` | GitHub 系抓取共用 HTTP 工具：clash CONNECT 隧道 + 直连回落，`fetchText/fetchJson`（404 抛 `HttpError`，超时可按场景收紧） |
| `scraper/login-qr-png.mjs` | 扫码登录，双后端：默认 chromium；`--browser lightpanda` 走 Lightpanda（自动 docker 拉起容器，CDP 不可达时） |
| `scraper/scheduler.mjs` | 调度器（本机 crontab 坏了，见 §9）。`--daemon/--worker/--stop`，pid/日志管理；默认每 15 分钟抓取（`SCRAPE_INTERVAL_MINUTES`，0=每日 `SCRAPE_TIME` 模式），pid 活性用 /proc cmdline 核对防误撞；抓取后自动打标 + 产物按天清理 |
| `scraper/tagger.mjs` | AI 自动打标：扫描无标签条目 → 智谱 API → 写标签库并合并回数据文件（详见 §2） |
| `scraper/tag-store.mjs` | 标签库读写/合并工具（`storage/zhihu-tags.json`，按条目原始 id 索引，原子写入） |
| `scraper/storage/zhihu-state.json` | 知乎登录态（cookie，含 z_c0）。**勿提交仓库**（已 gitignore） |
| `scraper/storage/zhihu-tags.json` | AI 标签库（id → tags[]）。已 gitignore；删掉它 = 全部重新打标 |
| `scraper/output/` | 抓取产物，同步后即废弃，可定期清理旧文件 |
| `scraper/test-lightpanda.mjs` | Lightpanda 连通性测试（CDP/二维码/cookie 往返） |
| `scraper/probe-lightpanda-scrape.mjs` | Lightpanda 抓取能力探测 |

### 抓取相关命令

```bash
npm run scrape                    # 立即抓取 → 自动同步到 public/data（含 chmod，见 §9）
npm run scrape:login              # chromium 扫码登录
npm run scrape:login:lightpanda   # Lightpanda 扫码登录
npm run sync:zhihu                # 只同步最新抓取结果（不抓取）
npm run scrape:github             # 抓 GitHub Trending 日榜 → 同步 public/data
npm run tag:zhihu                 # AI 打标：只处理无标签条目（TAG_LIMIT=3 可限量试跑）
npm run schedule:start|stop       # 调度器守护 启动/停止（前台：npm run schedule）
```

### Lightpanda 说明

- 本机 aarch64 + Debian 12 (glibc 2.36) **跑不了原生二进制**（要求 glibc 2.38），必须走官方 docker 镜像
- 镜像 entrypoint 是 tini，完整命令：`lightpanda serve --host 0.0.0.0 --port 9222`（只传 `serve` 或只传参数都会 exec 失败）
- 坑：`context.addCookies` 前必须先有活动页面（先 newPage + goto），否则报 `BrowserContextNotLoaded`
- 能力实测（nightly 1.0）：CDP 连接 ✅ 登录页/二维码 ✅ cookie 往返 ✅ 推荐流 API 拦截 ✅ **热榜 DOM 提取 ❌** → 抓取主链路仍用 chromium，登录可用 lightpanda
- 容器 `--restart unless-stopped` 常驻；不需要时 `docker rm -f lightpanda`，下次用会自动重建
- 登录态过期表现：抓取失败，scheduler.log 有提示 → `npm run scrape:login:lightpanda` 重新扫码（二维码存 `scraper/storage/login-qr.png`）

## 6. 生产部署（nginx docker）

```bash
docker run -d --name stories-nginx --restart unless-stopped \
  -p 20001:20001 \
  -v ~/stories/deploy/nginx.conf:/etc/nginx/conf.d/default.conf:ro \
  -v ~/stories/dist:/usr/share/nginx/html:ro \
  -v ~/stories/public/data:/usr/share/nginx/html/data:ro \
  nginx:alpine
```

- 配置：`deploy/nginx.conf`（listen 20001；`/assets/*` 30 天 immutable；`/data/*` no-cache + gzip；SPA 兜底 try_files → index.html）
- **更新数据免重建**：`npm run scrape` / `sync:zhihu` 即时生效（bind mount 实时目录）
- **改了前端代码**：`npm run build`；若 404/403 → `docker restart stories-nginx`（vite 清空 dist 可能导致 mount inode 失效）
- 移除：`docker rm -f stories-nginx`

## 7. Cloudflare Tunnel（公网入口）

- 宿主机已有 cloudflared 容器 `cloudflare_tunnel-cloudflared-1`：**host 网络模式 + TUNNEL_TOKEN（Dashboard 托管）**
- 因此公网路由在 **Cloudflare Zero Trust 后台**配置（本地无 config.yml）：添加 Public Hostname → Type `HTTP` → URL `localhost:20001`
- cloudflared 是 host 网络，`localhost:20001` 直接可达 nginx，无需改任何组网
- 公网可读，如需限制访问在同一 Public Hostname 上加 Access 策略（邮箱 OTP）

## 8. 关键版本与端口

| 项 | 值 | 原因/备注 |
| --- | --- | --- |
| playwright | **锁定 1.62.1**（无 ^） | 匹配 `~/.cache/ms-playwright` 已缓存浏览器（chromium-1234），装 1.63 会要求重下 150MB |
| react/vite/ts | ^18.3.1 / ^5.4.x / ~5.6.3 | 常规 |
| 20001 | stories-nginx | 生产入口 |
| 5173 | vite dev | 开发用 |
| 9222 | lightpanda CDP | 登录后端用 |

## 9. 本机环境约束（重要，新会话必读）

宿主机：**UGREEN NAS（UGOS）**，aarch64，Debian 12，glibc 2.36，ext4。

1. **本会话沙箱（AI 工具沙箱）**：每次 bash 调用是独立 bwrap 命名空间，**任何进程无法跨调用存活**（setsid/nohup 无效）。会话内长驻用后台任务（run_in_background），跨会话持久必须在**真实终端**启动。
2. **crontab 不可用**：`/var/spool/cron/crontabs` 属 nobody，fopen Permission denied；systemd user bus 也没有 → 一切定时用 `scraper/scheduler.mjs`。
3. **NAS 家目录权限保护层**：宿主视角文件是 777，但容器内进程看到 `700 uid1000` → nginx/docker 读不了新文件报 403。**已固化解决**：`build` 和 `sync:zhihu` npm scripts 末尾都带 `chmod -R a+rX`。**务必通过 npm scripts 执行**，手动跑底层命令新文件会 403。
4. `/home` 是 ro 挂载、`/home/gdipkf1986` 是 rw 挂载（同一块 ext4）。
5. dockerd 正常运行且**跨会话持久**（tailscale、cloudflared 已跑多天）→ docker 容器是唯一可靠的"常驻进程"载体。
6. web_search 工具无 API key（DEEPSEEK_API_KEY 未配置），查资料改用 curl/GitHub API。

## 10. 当前运行状态（截至本文档更新）

| 组件 | 状态 | 持久性 |
| --- | --- | --- |
| stories-nginx 容器 (:20001) | ✅ Up | docker 自恢复，重启机器自动回来 |
| lightpanda 容器 | 已清理 | 需要时登录脚本自动重建 |
| 每日调度器 | 之前以会话后台任务运行 | **会话结束即停**，持久化需在真实终端 `npm run schedule:start` |
| 知乎登录态 | ✅ 有效（2026-09-07 扫码） | 过期后 `npm run scrape:login:lightpanda` |

## 11. 目录速览

```
stories/
├── package.json            # 所有命令入口（scripts 注释见 §5/§6）
├── deploy/nginx.conf       # nginx 站点配置
├── scripts/sync-zhihu.mjs  # 抓取输出 → public/data 同步
├── scraper/                # §5 详述
├── public/data/            # 四个数据源 JSON（zhihu-feed 为生成物，已 gitignore）
├── src/
│   ├── types.ts            # 统一类型
│   ├── data/sources.ts     # 数据源注册表 + allSettled 聚合
│   ├── data/normalize.ts   # 适配器 + ZHIHU_KIND 映射 + avatarColorFor
│   ├── utils/format.ts     # 万级数字/相对时间/热度分
│   ├── components/         # Navbar Sidebar card/FeedCard HotTopics
│   ├── App.tsx             # 排序/过滤/状态机
│   └── index.css           # 知乎风格样式（--zhihu-blue 等 CSS 变量；移动优先，见下）
└── dist/                   # 构建产物（nginx 托管，已 gitignore）
```

### 响应式策略（2026-09-12 起为 mobile-first）

- **基础样式 = 手机（<640px）**：单列；来源筛选是吸顶横向滑动 chips（`.sidebar` `position:sticky; top:var(--nav-h)`）；热门榜移到信息流下方；搜索框与首页/通知按钮 `display:none`；卡片留白收紧、点按目标加大；`env(safe-area-inset-*)` 处理刘海/手势条
- **≥640px**：恢复搜索框与文字按钮、tab 恢复左对齐自然宽度、卡片恢复宽松内边距
- **≥900px**：经典三栏 grid（`168px minmax(0,1fr) 296px`），侧栏从 chips 恢复竖向卡片、提示卡恢复显示
- **踩坑**：`.sidebar .side-card { display:flex }` 的特异性 (0,2,0) 会压过 `.side-tip { display:none }` (0,1,0)，隐藏提示卡必须写成 `.sidebar .side-tip`
- 验证方式：`scripts/layout-verify.mjs` 用 Playwright 对 390/768/1280 三视口做程序化断言（若已删除可按 design.md 中的断言点重写）

## 12. 画像与推荐（2026-09-12 新增，借鉴 OpenBiliClaw）

数据源无关的行为反馈排序：**埋点 → 事件层 → 偏好层 → 推荐流**，纯规则零 LLM 成本。

```
浏览器埋点（喜欢/不感兴趣/点击，src/lib/feedback.ts，sendBeacon 批量）
  → /api/events（nginx JWT 后反代 → stories-api 容器，零依赖 node:http）
  → scraper/storage/events.jsonl        ① append-only，eid 去重，5MB 自动轮转
  → npm run profile → storage/profile.json   ② tag 权重（周衰减 0.9、<0.05 丢弃）、
  │                                          避雷(128)、来源/作者亲和、证据链；
  │                                          "显著变化"检测 = P3 LLM 画像触发钩子
  → npm run rank → public/data/recommendations.json  ③ 轻量推荐流(id+分+理由)
```

- 打分：`相关性×.30 + 时效×.10 − 疲劳×.25 − 来源单调×.15 + 探索×.20 + 作者加成`，
  Jaccard-MMR + tag/来源硬配额打散；权重移植自 OpenBiliClaw 生产校准值
- **人格描述（P3 soul.json）永远不进打分 prompt**——排序只吃结构化偏好层
- 前端"为你推荐"tab 按 recommendations.json 顺序渲染，推荐理由/探索徽标随卡展示；
  不感兴趣当场隐藏卡片（软信号，画像层衰减，非永久拉黑）
- **画像分析页（Navbar「画像」）**：ProfilePanel 展示兴趣/避雷/作者/来源四类分析，
  每条可确认/反对——裁决独立持久化 `storage/profile-verdicts.json`（重算不覆盖），
  engine 重算后作覆盖层叠加：tag 确认托底 0.75 / 反对清零；避雷反对移出；
  作者反对 → ranker 整条排除其内容；`POST /api/verdicts {key,verdict}`，key 形如 `tag:历史`
- 关键文件：`scraper/event-store.mjs`（事件层）、`scraper/profile-engine.mjs`（偏好层+裁决覆盖）、
  `scraper/verdict-store.mjs`（裁决层，`VERDICTS_FILE` 环境变量可覆盖路径）、
  `scraper/ranker.mjs`（排序）、`deploy/api.mjs` + `deploy/start-api.sh`（API 容器）、
  `scraper/sources.node.mjs`（**Node 侧源注册表，新数据源要在这里也加一行**）
- 已部署：`stories-api` 容器（stories-net 网络，仅 nginx 可达，`--user 1000:1000` 写 storage）；
  `npm run api:start` 可重启；验证：`docker exec stories-nginx wget -qO- http://stories-api:8787/api/health`
- 调度：每 15 分钟抓取链路自动跑 profile+rank；`RANK_HOURS`（默认 6）小时定时重排兜底。
  常驻方式二选一：① SSH 跑 `npm run schedule:start`（守护，重启后要重跑）；
  ② crontab 每 15 分钟 `node scraper/scheduler.mjs --once`（自带节流状态 storage/scheduler-state.json，重启免维护，推荐）。
  注意：AI 沙箱里 crontab spool 不可读、进程随会话销毁，"crontab 不可用"的旧结论是沙箱误判，宿主机 cron 正常（/etc/cron.d 有活例）。
  **调度器是新逻辑，需在真实终端重新 `npm run schedule:start` 才生效**
- 后续路线：P3 = LLM 人格画像（显著变化才触发）+ 探针 tag（lateral/bridge 破茧）；
  P4 = LLM 批量润色推荐理由；把 tagger.mjs 扩到 answers/news/blogs 源可让非知乎源的排序变准

## 13. 已知待办 / 可选方向

- 卡片点击进详情页（数据里多数条目有 url，可 iframe/外跳）
- 无限滚动分页（当前一次性全量渲染 ~140 条，暂无性能问题）
- 抓取历史积累：output/ 只增不删，量大后可做归档/清理策略
- Lightpanda 热榜 DOM 提取修复后，可把抓取也迁到 lightpanda（重跑 `probe-lightpanda-scrape.mjs` 评估）
