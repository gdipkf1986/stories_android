# stories mobile（Expo/RN App）

`~/stories`（多源 JSON 聚合的知乎风格时间线）的 **Android 原生前端**。

React Native（Expo SDK 57 / RN 0.86 / TypeScript）实现：不是 WebView 壳，UI 用真正的原生控件渲染（`FlatList` / `RefreshControl`）；数据层直接复用 web 端的 TS 代码（类型、归一化适配器、格式化工具），运行时从公网后端拉取 JSON。

- 后端：https://www.johuh.dpdns.org/（stories 的 nginx 静态托管）
- 数据源：`/data/zhihu-feed.json`、`/data/answers.json`、`/data/news.json`、`/data/blogs.json`
- 包名：`io.johuh.stories`

## 功能

- 多数据源并发加载，`Promise.allSettled` 容错（单个源挂掉不影响其他源，失败源顶部横幅提示）
- 来源筛选 chips（全部 / 知乎推荐流 / 知乎回答 / 科技资讯 / 博客专栏）
- **JWT 认证**：登录页输入访问密码 → `POST /auth/login` 换取 token（30 天有效）→ 持久化到 AsyncStorage，之后所有请求自动带 `Authorization: Bearer`；后端返回 401 时自动回到登录页
- 最新（时间倒序）/ 热门（热度分 = 各指标求和）排序
- 下拉刷新、加载态、全失败重试页、空态
- 卡片：头像（按作者名稳定取色）、动作文案、来源徽标、AI 分类标签、万级数字 / 相对时间
- **画像分析页（v1.2.0）**：顶栏「画像」进入，展示系统学到的分析结果（兴趣权重 / 避雷 / 作者亲和 / 来源分布），
  每一条可「确认 / 反对」（用户裁决持久化在后端，AI 重算不覆盖；已反对的可撤销）；
  数据来自 `GET /api/profile`，裁决提交 `POST /api/verdicts`，同样走 Bearer 认证，401 回登录页
- **应用内更新（v1.3.0）**：启动时静默查 `GET /data/app/latest.json`（NAS 端由 `scripts/publish-apk.sh` 发布），
  按 versionCode（= CI run number）判断有无新版本 → 顶部横幅提示 → 应用内下载（带进度、Bearer 认证）→
  拉起系统安装器；Android 8+ 首次安装需允许「安装未知应用」（下载失败横幅里有「授权」快捷入口）。
  分发走 NAS 镜像而非 GitHub：私有仓库的 artifact/release 都要鉴权，把 token 打进 APK 等于泄露
- 点卡片/查看原文 → 直接唤起知乎 App（`expo-intent-launcher` 显式 Intent：`data=zhihu://<path>` + `packageName=com.zhihu.android`；未装知乎回落系统浏览器，非知乎链接走浏览器）
  - ⚠️ 坑：**不要用 `Linking.openURL('intent://...')`**。RN 0.86 的 `IntentModule.openURL` 实现是
    `Intent(ACTION_VIEW, Uri.parse(url))`，不解析 `intent://...#Intent;...end` 包装（老版本的
    `Intent.parseUri(url, URI_INTENT_SCHEME)` 已移除），intent: scheme 无应用可处理，
    必然异常回落浏览器（症状：点开是 Edge）
- 登录页底部显示应用版本号（`expo-constants`），装完可核对
- 自适应图标 + Android 13 单色主题图标 + 知乎蓝启动屏

## 目录结构

```
mobile/
├── App.tsx                     # 主屏：加载/刷新/筛选/排序/错误态
├── index.ts                    # 入口（registerRootComponent）
├── app.json                    # Expo 配置（包名、图标、启动屏）
├── eas.json                    # EAS 云构建配置（preview = APK，production = AAB）
├── scripts/make-icons.mjs      # 图标生成脚本（纯 Node，无依赖）
├── scripts/publish-apk.sh      # 把 apk/ 最新 artifact 发布到 stories 后端（latest.json），供 App 内更新
├── .github/workflows/build-apk.yml  # CI：类型检查 + 产出 APK
└── src/
    ├── types.ts                # 统一时间线条目类型（与 web 端一致）
    ├── api/
    │   ├── config.ts          # API_BASE（后端地址在这改）
    │   ├── sources.ts         # 数据源注册表 + 并发加载 + Bearer 附加
    │   ├── auth.ts            # 登录 / token 持久化（AsyncStorage）
    │   ├── profile.ts         # 画像分析 API（GET /api/profile + POST /api/verdicts）
    │   ├── update.ts          # 应用内更新（latest.json 检查 + 下载 + 拉起安装器）
    │   └── normalize.ts       # 每个源一个适配器，归一化成 TimelineItem
    ├── components/
    │   ├── card/
    │   │   ├── FeedCard.tsx   # 唯一的条目卡片（所有源/子板块通用，规范见同目录 README）
    │   │   ├── cardModel.ts   # TimelineItem → CardModel 纯逻辑（web 端有镜像，改必同步）
    │   │   └── README.md      # 一卡到底规范 + 新数据源接入步骤
    │   ├── TopBar.tsx         # 顶栏：logo + 排序 + 来源筛选 + 画像入口
    │   ├── ProfileScreen.tsx  # 画像分析页：四类分析结果 + 逐条确认/反对
    │   ├── UpdateBanner.tsx   # 顶部更新横幅（新版本/下载进度/点击安装）
    │   └── LoginScreen.tsx    # 登录页（401 时展示）
    └── utils/
        └── format.ts          # 万级数字 / 相对时间 / 热度分
```

## 日常开发

手机和 NAS 在同一局域网时，用 **Expo Go** 实时预览（无需构建）：

```bash
cd ~/stories/mobile
npm start            # Metro 启动后，手机 Expo Go 扫终端二维码
```

> 二维码地址默认是局域网 IP；连不上时用 `npx expo start --tunnel` 走内网穿透。
> `react-native-safe-area-context`、`expo-splash-screen` 均内置于 Expo Go，免构建直接生效。

类型检查：

```bash
npx tsc --noEmit
```

## 打包 APK

> **只出 arm64 包**（2026-09-12 定）：本项目的 APK 只包含 `arm64-v8a` 一种架构，
> 由 `app.json` 里 `expo-build-properties` 插件的 `android.buildArchs: ["arm64-v8a"]`
> 控制（prebuild 时写入 gradle.properties 的 `reactNativeArchitectures`）。
> 通用 4 架构包约 66MB，arm64 单架构包约 25MB 左右。
> 2019 年以后的手机全是 arm64；如需兼容 32 位或其他模拟器架构，把 `buildArchs`
> 改回 `["arm64-v8a", "armeabi-v7a", "x86_64"]` 即可。

**版本号规则**：
- 应用版本号在 `app.json` 的 `expo.version`（发新功能时手动升级，如 `1.1.0`）；
- `versionCode` 由 CI 自动注入 = GitHub run number（每次构建单调递增，覆盖安装永不冲突）；
- CI 产出的 APK 文件名固定带版本：`stories-v{版本}-arm64-r{构建号}.apk`；
- 登录页底部会显示当前安装的版本号。

本机（aarch64 NAS）没有 Android SDK，也跑不了 x86_64 的 build-tools，**本地不能出包**，两条路：

### 方式一：GitHub Actions（推荐，免费无需注册）

推到 GitHub 后自动构建，APK 在 Actions 产物里下载：

```bash
cd ~/stories/mobile
git init && git add -A && git commit -m "init"
git remote add origin git@github.com:gdipkf1986/stories_android.git
git push -u origin main
# 或在 GitHub 网页上手动触发 Build Android APK workflow
```

产物：`stories-apk`（debug 签名的 release APK，可直接安装）。
打 `v*` tag 推送时，APK 会自动挂到 GitHub Release。

### 方式二：EAS 云构建（Expo 官方，需免费账号）

```bash
npm i -g eas-cli
eas login
eas build -p android --profile preview   # 直接产出可安装 APK
```

### 方式三：任意有 Android Studio 的电脑

```bash
npm install
npx expo prebuild -p android
cd android && ./gradlew assembleRelease
# 产物 android/app/build/outputs/apk/release/app-release.apk
```

## 配置

| 想改什么 | 改哪里 |
| --- | --- |
| 后端地址 | `src/api/sources.ts` 的 `API_BASE`，或构建时环境变量 `EXPO_PUBLIC_API_BASE`（eas.json / CI 已内置） |
| 应用名 / 包名 / 图标 | `app.json`；图标改动后 `node scripts/make-icons.mjs` 重新生成 |
| 版本号 | `app.json` 的 `expo.version`；发新版建议同步打 `v*` tag |
| 接入新数据源 | 后端 `public/data/` 放 JSON → `src/api/normalize.ts` 写适配器 → `src/api/sources.ts` 注册 |

## 与 web 端的关系

数据层（`types.ts` / `normalize.ts` / `format.ts`）与 `~/stories/src/` 同源同构，web 端加了新数据源后，把对应适配器搬过来即可。UI 层互不依赖：web 面向桌面三栏，本工程是移动端单列信息流。
