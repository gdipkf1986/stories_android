# FeedCard —— 一张卡片打天下

`mobile/src/components/card/` 是全项目**唯一的条目卡片**：

```
card/
├── cardModel.ts   # 纯逻辑：TimelineItem + CardVisual → CardModel（无 JSX，可单测，web 端有镜像）
├── FeedCard.tsx   # 唯一的卡片组件：照 CardModel 画，RN 实现（安卓主力）
└── README.md      # 本规范
```

## 铁律：一卡到底

- **源内所有子板块**（知乎 recommend/follow/hot、B站 popular/rank……）的条目一律由 `FeedCard` 渲染。
- **接入新数据源时不许新写卡片组件**。`FeedCard` 里不允许出现 `item.source === 'xxx'` 这类分支；
  例外仅限与「长相」无关的平台工具（如 `openItemUrl` 的深链分发）。
- 侧栏聚合类小组件（如 `HotTopics` 热门榜：整块一个组件，行点击只是委托上层
  `openItemUrl` 打开原文）不是内容卡片，不在此约束内；
  但只要渲染**某源的单条内容**，就必须走 FeedCard。

## 数据流（为什么一张卡能画所有源）

```
public/data/*.json ──normalize.ts 适配器──▶ TimelineItem（统一结构）
                                            │
sources.ts 注册表 ── SourceMeta(card?) ──▶ resolveCardModel() ──▶ CardModel ──▶ FeedCard
```

1. **数据差异**在 `normalize.ts` 解决：新源的字段映射成 `TimelineItem` 公共字段
   （author/title/excerpt/metrics/tags/cover/feed…），卡片不关心它来自谁。
2. **长相差异**在注册表解决：`sources.ts` 该源条目上配 `card: CardVisual`（可选）：
   - `coverAspect`：封面宽高比，缺省 16:9（B站标准）；
   - `maxMetrics`：底部最多展示几个指标，缺省 3。
   两者的缺省值集中在 `cardModel.ts` 的 `DEFAULT_CARD_VISUAL`。
3. **推荐位**（「为你推荐」的理由/探索徽标）由调用方传 `reason` / `explore` props，卡片不查询推荐流。

## 接入新数据源（卡片零改动）

1. 后端 `public/data/` 放新 JSON；
2. `src/api/normalize.ts` 写适配函数（宽松防御写法，参考 bilibili）并注册进 `NORMALIZERS`；
3. `src/api/sources.ts` 的 `SOURCES` 加一条 `{ id, label, kind, color, file, feeds?, card? }`；
4. 完事——时间线、筛选、子板块下拉、FeedCard 渲染全部自动生效。

## web / 安卓双端关系

两端**不共享代码**（仓库约定），靠**镜像副本**保持同构：

- `web/src/components/card/cardModel.ts` 是本目录 `cardModel.ts` 的镜像（仅 import 路径不同，
  web 端类型/适配器在 `src/data/` 而非 `src/api/`）；
- `web/src/components/card/FeedCard.tsx` 是同一份 CardModel 契约的 DOM 实现
  （`<img>`/`<a>`/CSS），交互与 RN 版一一对应；
- **改 cardModel 必须两端同步**，否则双端卡片会静默不一致（同 `types.ts` 等既有镜像的约定）。
  安卓端是权威版本：先改 mobile，再镜像到 web。
