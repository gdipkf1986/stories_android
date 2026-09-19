# 知乎深链故障排查记录（2026-09-19，第 6 次）

> 这是 mobile/AGENTS.md「⚠️ 深链唤起问题」历史坑列表的**第 6 次**实例排查档案。
> 症状同前 5 次：为你推荐里点知乎卡片，打开的是浏览器而不是知乎 App。
> 本档案记录当次排查证据链与结论；**结论未定案，缺一步真机实测（见 §4）**。

## 1. 症状

- 场景：APK「为你推荐」流，点知乎条目卡片 → 打开浏览器。
- 时间点：v1.5.12-r25（2026-09-19 上午）刚发布后报障。
- 关键事实：本次发布（`7010378..4ace229`）只动了 GitHub 源、卡片折叠交互、
  AGENTS 文档，**未触碰任何深链相关文件**（见 §3-③）。

## 2. 排查证据链（按 mobile/AGENTS.md 排查清单）

| # | 检查项 | 结果 | 证据 |
|---|--------|------|------|
| ① | URL 形态是否被覆盖 | ✅ 排除 | 对线上 `zhihu-feed.json` 全量 99 条跑 `toZhihuDeepPath` 模拟：`question/{qid}/answer/{aid}` ×52、`question/{qid}` ×38、`zhuanlan.zhihu.com/p/{pid}` ×4、`pin/{pid}` ×5，**全部命中映射，零 MISS** |
| ② | 深链路由形式实测 | ⚠️ **未完成** | 服务器无 adb/真机，无法发起实测。`question/{qid}` 上次实测可用是 2026-09 初，此后**用户手机上的知乎 App 可能已自动更新** |
| ③ | APK manifest `<queries>` | ✅ 排除 | 对已发布 `stories-v1.5.12-arm64-r25.apk` 跑 utf16 关键字检查：`zhihu` / `bilibili` / `queries` / `REQUEST_INSTALL` 四项全 OK |
| ④ | 代码层静态限制 | ✅ 排除 | `openAndroidDeepLink` 仍是 ACTION_VIEW + data + packageName 结构；无 `intent://`；`git diff 7010378..4ace229` 对 `zhihu-app.ts` / `plugins/` / `app.json` / 依赖清单为空 |

## 3. 结论（暂定）

静态层（我们的代码、数据形态、APK manifest）逐项验证全部完好，因此问题指向
**知乎 App 侧变化**，两种可能（不互斥）：

1. **知乎 App 自动更新后 `zhihu://question/{qid}` 路由退化**——和历史上
   「老式复数路由在知乎新版本上不可信」同类，只是这次退化的是单数路由；
2. intent 正常送达但**知乎 App 内部路由失败转投 web**——表里 #5 的提醒：
   「浏览器被打开 ≠ intent 没发出去」，`openAndroidDeepLink` 的 catch 吞掉一切
   失败回落浏览器，但知乎收到深链自己跳 web 也会呈现同样症状。

⚠️ 在真机实测（§4）出结果前，**不要动映射表**——现状是全部静态层经过验证的
已验证结构，头痛医头改映射只会引入新变量。

## 4. 待办：真机实测（需要装了知乎 App 的手机 + adb）

```bash
# 观察 intent 落到哪个包（重点看 zhihu 是否收到、ActivityTaskManager 怎么分发）
adb logcat | grep -iE "ActivityTaskManager|ACTIVITY|zhihu"

# 用线上真实 id 逐个发深链（每条之间观察手机实际反应）
adb shell am start -a android.intent.action.VIEW -d "zhihu://question/2084296008213553886"
adb shell am start -a android.intent.action.VIEW -d "zhihu://question/1937794794614157647"
adb shell am start -a android.intent.action.VIEW -d "zhihu://articles/2084263024462915496"
# 顺手记录知乎 App 版本（退化与否的锚点）
adb shell dumpsys package com.zhihu.android | grep versionName
```

**候选路由实测矩阵**（哪个能跳就在映射表里用哪个；都跳不了 = 知乎侧坏了，等修复）：

| 候选 | 历史 | 待实测 |
|------|------|--------|
| `zhihu://question/{qid}` | 2026-09 初实测可用 | ☐ |
| `zhihu://questions/{qid}`（复数） | 雪花 id 上不跳转 | ☐ |
| `zhihu://answers/{aid}`（精确回答页） | 雪花 aid 上不跳转 | ☐ |
| `zhihu://articles/{pid}` | 曾验证可用 | ☐ |
| `zhihu://pins/{pid}` | 曾验证可用 | ☐ |

## 5. 修复记录（实测后回填）

- [ ] 真机实测完成（日期 / 知乎版本 / 各候选路由结果）
- [ ] 按实测结论修 `mobile/src/utils/zhihu-app.ts` 映射表（如需），web 端镜像注释同步
- [ ] mobile/AGENTS.md 坑列表补一行（第 6 次）
- [ ] 推送发版（先经用户确认），真机回归验证为你推荐流
