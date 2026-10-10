const { withAndroidManifest, withMainActivity } = require('@expo/config-plugins');

const withShareReceiver = (config) => {
  config = withAndroidManifest(config, (config) => {
    const activity = config.modResults.manifest.application?.[0]?.activity?.find(
      (candidate) => candidate.$?.['android:name'] === '.MainActivity',
    );
    if (!activity) return config;

    activity['intent-filter'] ||= [];
    const hasSendFilter = activity['intent-filter'].some((intentFilter) =>
      (intentFilter.action ?? []).some(
        (action) => action.$?.['android:name'] === 'android.intent.action.SEND',
      ),
    );
    if (!hasSendFilter) {
      activity['intent-filter'].push({
        action: [
          { $: { 'android:name': 'android.intent.action.SEND' } },
        ],
        category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
        data: [{ $: { 'android:mimeType': 'text/plain' } }],
      });
    }
    return config;
  });

  return withMainActivity(config, (config) => {
    let contents = config.modResults.contents;

    if (!contents.includes('import expo.modules.sharereceiver.ShareReceiverStore')) {
      contents = contents.replace(
        /^(package [^\n]+\n)/,
        '$1\nimport expo.modules.sharereceiver.ShareReceiverStore\n',
      );
    }

    if (!contents.includes('ShareReceiverStore.captureIntent')) {
      contents = contents.replace(
        /(override fun onCreate\(savedInstanceState: Bundle\?\) \{\n)/,
        '$1    ShareReceiverStore.captureIntent(intent)\n',
      );
      const backButtonMarker = '  /**\n    * Align the back button behavior with Android S';
      const onNewIntentOverride = '  override fun onNewIntent(intent: android.content.Intent?) {\n    ShareReceiverStore.captureIntent(intent)\n    super.onNewIntent(intent)\n  }\n\n';
      if (contents.includes(backButtonMarker)) {
        contents = contents.replace(backButtonMarker, `${onNewIntentOverride}${backButtonMarker}`);
      } else {
        contents = contents.replace(/\n*\}$/, `\n${onNewIntentOverride}}\n`);
      }
    }

    config.modResults.contents = contents;
    return config;
  });
};

module.exports = withShareReceiver;
