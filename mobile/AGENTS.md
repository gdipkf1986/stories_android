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
用户确认，见上文「⚠️ 推送前必须向用户确认」**）：确认推送后，拉取/发布由常驻 systemd timer 自动
完成，不再创建一次性 sleep 延时任务。`stories-apk-release.timer` 每 10 分钟对账 GitHub 最新
Release；发现本地 `latest.json` 落后时，用 `gh` 下载该 Release 的 APK，清掉旧 artifact 并调用
`publish-apk.sh`。**下载必须走 clash 代理**（已写在 service 的 `Environment=` 里），否则大文件
会直连卡死。

安装/更新本机任务：

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/user/stories-apk-release.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now stories-apk-release.timer
systemctl --user list-timers stories-apk-release.timer
```

最后一步 `scripts/publish-apk.sh` 把新 APK 发布到 stories 后端（`~/stories/public/data/app/` +
原子写 `latest.json`），App 内的更新检查（`src/api/update.ts`，打开/回前台时静默查、横幅提示
下载安装）就能发现新版本。App 会先探测 `http://192.168.0.89:20001/login`；命中 stories 后端时
`latest.json` 和 APK 都从内网下载，探测失败或缓存过期后回落公网。别漏掉发布这一步，否则手机端
永远提示不出更新。

# ⚠️ 深链唤起问题（点卡片打开的是浏览器而不是知乎/B站 App）

`src/utils/zhihu-app.ts` 负责把条目 URL 转成知乎/B站 App 深链，失败回落系统浏览器。
**这个问题前后反复出现过 6 次**，每次都是同一类坑的新变体。修过的一律不要再退化，
遇到「又打不开 App 了」按下面的排查清单走，不要头痛医头。

> 📁 **历次排查档案**在 `docs/deep-link-incident-*.md`（最新：2026-09-19 第 6 次已定案——
> 路由层全矩阵实测 ✓ 排除知乎侧，根因是 IntentLauncher 单点投递失败，改三级投递修复，见档案 §6）。
> 排查时先读对应档案避免重复劳动；新排查完建新档案并在根 AGENTS.md「排障记录索引」登记。

## 已踩过的坑（历史修复，按链路顺序）

| # | 坑 | 修复 | commit |
|---|----|------|--------|
| 1 | RN 0.86 起 `Linking.openURL('intent://…')` 不再解析 intent URI（改成 `Intent(ACTION_VIEW, Uri.parse(url))`），intent 包装必然 `ActivityNotFoundException` | 改用 `expo-intent-launcher` 发 `ACTION_VIEW` + `data={scheme}://{deepPath}` | e224c4f |
| 2 | `IntentLauncher.startActivityAsync` 的 `packageName` 参数**必须配合 className 才生效**，单独传被静默忽略 → 实际发出的是隐式 intent → Android 11+ 包可见性过滤查不到目标 App | `plugins/with-queries.js` 向 manifest 注入 `<queries>`（zhihu/bilibili 两个 scheme） | c9c3d59 |
| 3 | 裸问题页深链用老式复数路由 `questions/{qid}`：知乎 **19 位雪花 id** 上不跳转 | 改单数 `question/{qid}`（已实测可用） | 0a55e1a |
| 4 | 推荐流主力形态 `/question/{qid}/answer/{aid}` 映射 `answers/{aid}`——同为老式复数路由，雪花 aid 上不跳转 → 整个推荐流的知乎条目全回落浏览器（热榜是裸问题页所以没症状，导致「只有为你推荐有问题」的错觉） | 回落到已验证的 `question/{qid}`（打开问题页）；日后实测出 answers 精确路由可用再恢复 | （本次） |
| 5 | 同类坑换皮：`REQUEST_INSTALL_PACKAGES` 权限缺失 → 应用内更新点「安装」无反应（Android 8+ 静默丢弃安装 intent） | manifest 补权限 | 19f9dd2 |
| 6 | `IntentLauncher` 单点投递在设备上系统性失败（路由层 10 条候选全 ✓ 排除知乎侧、manifest `<queries>` 在位排除可见性），点卡片必开浏览器 | `openAndroidDeepLink` 改三级投递：IntentLauncher → RN `Linking`（独立路径）→ 浏览器；1.5.13 实测修复 | 9694359 |

**规律：知乎新式雪花 id（19 位）下，老式复数深链路由（questions/answers）一律不可信；
只认实测过的形式。** 已验证可用（2026-09-19 真机全矩阵复测）：`question/{qid}`、`questions/{qid}`、
`answers/{aid}`、`answer/{aid}`、`articles/{pid}`、`article/{pid}`、`pins/{pid}`、`pin/{pin}`、
`people/{token}`；未验证存疑：`videos/{id}`。⚠️ 复测同时推翻了「复数不跳」的旧结论
（知乎更新后路由处理已容错），映射仍维持保守的 `question/{qid}`，无切换收益。
另一条规律：**「开浏览器」只说明走到了兜底，投递层值得留两条独立路径**（见坑 6）。

## 排查清单（出现「打不开 App」时按序查）

1. **URL 形态是否被覆盖**：`toZhihuDeepPath()` 返回 null 会直接走浏览器。跑形态统计，
   新出现的数据形态（如移动端 `tardis/zm/art/{id}`、短链 `b23.tv`、老式 `av{id}`）要补映射：
   ```bash
   node -e "const fs=require('fs');const urls=[];for(const f of ['zhihu-feed.json','bilibili-feed.json']){const d=JSON.parse(fs.readFileSync('public/data/'+f,'utf8'));for(const fd of d.feeds||[])for(const it of fd.items||[])if(it.url)urls.push(it.url)};const c={};for(const u of urls){const s=(()=>{try{const x=new URL(u);return x.host+x.pathname.replace(/[0-9]{4,}/g,'{id}').replace(/BV[0-9A-Za-z]+/,'{bvid}')}catch{return 'INVALID:'+u}})();(c[s]=c[s]||[]).push(u)};for(const[s,l]of Object.entries(c))console.log(String(l.length).padStart(4),s,l[0])}"
   ```
   （在仓库根跑；每种形态必须能命中 `toZhihuDeepPath`/`toBilibiliBvid`）
2. **深链路由形式在雪花 id 上实测过没有**：见上表「已验证/存疑」。换知乎 App 版本后建议重新实测。
3. **APK manifest 是否真的带 `<queries>`**：CI 每次构建都重新 `expo prebuild`，
   config plugin 挂了就**静默退化**成没有包可见性声明 → `ActivityNotFoundException` → 回落浏览器。
   验证已发布 APK（在仓库根跑，keywords 命中 utf16 即注入成功）：
   ```bash
   unzip -p mobile/apk/*.apk AndroidManifest.xml > /tmp/opencode/axml && node -e "
   const b=require('fs').readFileSync('/tmp/opencode/axml');
   for(const k of ['zhihu','bilibili','queries','REQUEST_INSTALL'])
     console.log(k.padEnd(20), b.indexOf(Buffer.from(k,'utf16le'))>=0 ? 'OK' : 'MISSING!')"
   ```
4. **代码层两个静态限制**（zhihu-app.ts 头注释有完整说明）：不能用 `Linking.openURL('intent://…')`；
   `IntentLauncher` 的 `packageName` 单独传无效。别「优化」掉现有的 ACTION_VIEW + `<queries>` 结构。

## 真机验证

```bash
adb logcat | grep -iE "ActivityTaskManager|ACTIVITY|zhihu"   # 看 intent 解析到哪个包
adb shell am start -a android.intent.action.VIEW -d "zhihu://question/{qid}"  # 手动发深链
```

注意：`openAndroidDeepLink` 的 catch 会把一切失败吞掉回落浏览器，**浏览器被打开 ≠ intent 没发出去**，
也可能是知乎 App 收到深链后自身路由失败转投 web——所以第 2 步的「路由形式实测」不可省。

## 镜像副本提醒

`src/utils/zhihu-app.ts` 移植自 web 端同名文件（不共享代码），两边深链映射表保持一致；
web 端已冻结，仅在 mobile 侧改动时同步注释与映射即可，不必触发 web 发布。

