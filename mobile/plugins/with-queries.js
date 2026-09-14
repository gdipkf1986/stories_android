/**
 * Expo config plugin：向 AndroidManifest 注入 <queries> 声明。
 *
 * 为什么需要：Android 11+（API 30）包可见性过滤。App 用隐式 ACTION_VIEW
 * 解析自定义 scheme（zhihu://、bilibili://）时，若 manifest 没有 <queries>
 * 声明，PackageManager 查不到任何处理器 → ActivityNotFoundException。
 * （expo-intent-launcher 的 packageName 参数必须配合 className 才生效，
 * 单独传会被忽略，所以实际发出的是隐式 intent，见 src/utils/zhihu-app.ts）
 */
const { withAndroidManifest } = require('@expo/config-plugins');

const SCHEMES = ['zhihu', 'bilibili'];

const withAppQueries = (config) => {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults?.manifest;
    if (!manifest) return config;

    const intents = SCHEMES.map((scheme) => ({
      action: { $: { 'android:name': 'android.intent.action.VIEW' } },
      data: { $: { 'android:scheme': scheme } },
    }));

    const existing = manifest.queries?.[0]?.intent;
    if (Array.isArray(existing)) {
      existing.push(...intents);
    } else if (manifest.queries?.[0]) {
      manifest.queries[0].intent = intents;
    } else {
      manifest.queries = [{ intent: intents }];
    }
    return config;
  });
};

module.exports = withAppQueries;
