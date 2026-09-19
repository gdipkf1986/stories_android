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

## 4. 真机实测结果（2026-09-19 10:03，Edge Android 153 / 已完成 ✅）

用 `/deeplink-test.html`（B站对照行自检 intent 链路）实测，报告全文要点：

| 候选路由 | 结果 | 备注 |
|----------|------|------|
| `bilibili://video/{bvid}` | ✓ | 对照组通过：系统 scheme→App 链路正常 |
| `zhihu://question/{qid}` | ✓ | APK 现用路由，可用 |
| `zhihu://questions/{qid}`（复数） | ✓ | **历史结论被推翻**：雪花 id 上现在能跳 |
| `zhihu://question/{qid}/answer/{aid}` | ✓ | 组合形态可用 |
| `zhihu://answers/{aid}`（复数） | ✓ | **历史结论被推翻** |
| `zhihu://answer/{aid}`（单数） | ✓ | |
| `zhihu://articles/{pid}` / `article/{pid}` | ✓ | |
| `zhihu://pins/{pin}` / `pin/{pin}` | ✓ | |
| `zhihu://people/{token}` | 未测 | 选测行留空 |

知乎版本：未记录（测试页该栏留空）。结论：**知乎 App 当前版本路由处理全面容错，
10 条候选全可用，「路由退化」假设被实测推翻。**

## 5. 修复记录

- [x] 真机实测完成（2026-09-19，Edge Android；知乎版本未记录）
- [x] 映射表**维持不变**：`answer/{aid}` 形态仍回落 `question/{qid}`——全矩阵均可用，
      保守映射无切换收益；两端文件头注释已记录复测结论（历史「复数不跳」作废）
- [x] 投递层加固：`openAndroidDeepLink` 在 IntentLauncher 抛错后先经 RN `Linking`
      重试一次（独立投递路径），仍失败才回落浏览器
- [ ] **待办（定案关键）**：手机上直接在 APK 里点一张知乎卡片复测——
  - 若知乎正常唤起：定案为「知乎 App 更新窗口期的一次性投递失败」，无需发版，加固代码随下次版本捎带；
  - 若仍开浏览器：问题锁定在 APK 自身投递层（r25），需要 `adb logcat` 抓 `ActivityNotFoundException`，届时再发加固版
- [ ] mobile/AGENTS.md 坑列表补一行（第 6 次，待 APK 复测定案后补全结论）
- [ ] 推送发版（先经用户确认），真机回归验证为你推荐流

## 6. 定案（2026-09-19）

- [x] **APK 内复测通过**：用户升级 1.5.13 (r26) 后，为你推荐点知乎卡片正常唤起知乎 App
- [x] 推送发版完成（e490789 → build run 35415334574 → v1.5.13-r26，用户确认后发布）
- **根因**：`IntentLauncher` 单点投递在用户设备上系统性失败（r25 时点卡片必开浏览器，
  同一 id 浏览器发 scheme 却全通，排除路由/manifest）。真因未抓 logcat——adb 已在
  本机备好（`~/adb-local/`，arm64 deb 解包 + 包装脚本），复发即可抓 `ActivityTaskManager` 定位
- **修复**：`openAndroidDeepLink` 三级投递 IntentLauncher → RN `Linking`（独立路径）→
  浏览器（commit 9694359，随 1.5.13-r26 发布实测生效）

**经验沉淀**：投递失败不一定是路由/manifest 的锅；「浏览器被打开」只说明走到了兜底，
兜底之前多一条独立投递路径，比事后猜路由可靠得多。

## 附注：测试页工具化（顺带修的一个流程坑）

之前做过一版深链测试页（`/deeplink-test.html`），但当时只写进了 `web/dist/`
——**dist 是 vite 的生成物，未入库的唯一副本会随任何一次构建消失**，本次排查
建新页时同名覆盖，旧页无法恢复。教训：

- 给 web 加任何长期页面/工具，源文件必须放 `public/`（vite `publicDir = ../public`）
  进版本库，dist 里只留构建产物；
- 往 dist 拷/改文件前先确认没有未入库的旧内容。

本次新页 `public/deeplink-test.html` 已按此转正：预填线上真实雪花 id、
10 条知乎候选路由 + B站对照行、✓/✗ 判定存 localStorage、一键生成报告。
线上入口：`https://www.johuh.dpdns.org/deeplink-test.html`（受 JWT 认证门保护）。
