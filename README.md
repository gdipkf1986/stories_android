# stories_android

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
- 点卡片 → 系统浏览器打开原文链接
- 自适应图标 + Android 13 单色主题图标 + 知乎蓝启动屏

## 目录结构

```
stories_android/
├── App.tsx                     # 主屏：加载/刷新/筛选/排序/错误态
├── index.ts                    # 入口（registerRootComponent）
├── app.json                    # Expo 配置（包名、图标、启动屏）
├── eas.json                    # EAS 云构建配置（preview = APK，production = AAB）
├── scripts/make-icons.mjs      # 图标生成脚本（纯 Node，无依赖）
├── .github/workflows/build-apk.yml  # CI：类型检查 + 产出 APK
└── src/
    ├── types.ts                # 统一时间线条目类型（与 web 端一致）
    ├── api/
    │   ├── config.ts          # API_BASE（后端地址在这改）
    │   ├── sources.ts         # 数据源注册表 + 并发加载 + Bearer 附加
    │   ├── auth.ts            # 登录 / token 持久化（AsyncStorage）
    │   └── normalize.ts       # 每个源一个适配器，归一化成 TimelineItem
    ├── components/
    │   ├── TimelineCard.tsx   # 时间线卡片
    │   ├── TopBar.tsx         # 顶栏：logo + 排序 + 来源筛选
    │   └── LoginScreen.tsx    # 登录页（401 时展示）
    └── utils/
        └── format.ts          # 万级数字 / 相对时间 / 热度分
```

## 日常开发

手机和 NAS 在同一局域网时，用 **Expo Go** 实时预览（无需构建）：

```bash
cd ~/stories_android
npm start            # Metro 启动后，手机 Expo Go 扫终端二维码
```

> 二维码地址默认是局域网 IP；连不上时用 `npx expo start --tunnel` 走内网穿透。
> `react-native-safe-area-context`、`expo-splash-screen` 均内置于 Expo Go，免构建直接生效。

类型检查：

```bash
npx tsc --noEmit
```

## 打包 APK

本机（aarch64 NAS）没有 Android SDK，也跑不了 x86_64 的 build-tools，**本地不能出包**，两条路：

### 方式一：GitHub Actions（推荐，免费无需注册）

推到 GitHub 后自动构建，APK 在 Actions 产物里下载：

```bash
cd ~/stories_android
git init && git add -A && git commit -m "init"
git remote add origin git@github.com:<you>/stories_android.git
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
