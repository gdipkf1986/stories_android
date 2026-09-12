import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { UpdateInfo, UpdatePhase } from '../api/update';

const MB = 1024 * 1024;

type Props = {
  info: UpdateInfo;
  phase: UpdatePhase;
  onPress: () => void;
  onOpenSettings: () => void;
};

/**
 * 顶部更新横幅：发现新版本 → 下载（带进度）→ 点击安装。
 * 状态机由 Root 持有，本组件只负责展示。
 */
export default function UpdateBanner({ info, phase, onPress, onOpenSettings }: Props) {
  let label = '';
  let sub = '';
  let enabled = true;

  if (phase.state === 'downloading') {
    enabled = false;
    const pct = phase.total > 0 ? Math.round((phase.written / phase.total) * 100) : 0;
    label = `新版本下载中 ${pct}%`;
    sub = `${(phase.written / MB).toFixed(1)} / ${(phase.total / MB).toFixed(1)} MB`;
  } else if (phase.state === 'readyToInstall') {
    label = '✅ 下载完成，点击安装';
  } else if (phase.state === 'error') {
    label = `⚠️ ${phase.message}，点击重试`;
    sub = '装不上？先去系统设置授权「安装未知应用」→';
  } else {
    label = `🚀 发现新版本 v${info.version}`;
    sub =
      info.sizeBytes > 0
        ? `点击下载更新（${(info.sizeBytes / MB).toFixed(1)} MB）`
        : '点击下载更新';
  }

  return (
    <View style={styles.wrap}>
      <Pressable
        style={({ pressed }) => [styles.main, pressed && enabled && styles.pressed]}
        onPress={enabled ? onPress : undefined}
        disabled={!enabled}
        android_ripple={{ color: '#0000000a' }}
      >
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        {!!sub && <Text style={styles.sub}>{sub}</Text>}
      </Pressable>
      {phase.state === 'error' && (
        <Pressable style={styles.settings} onPress={onOpenSettings} hitSlop={6}>
          <Text style={styles.settingsText}>授权</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: '#e8f3ff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#b3d7ff',
  },
  main: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 2,
  },
  pressed: {
    backgroundColor: '#d6ebff',
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0a5cb8',
  },
  sub: {
    fontSize: 12,
    color: '#4a86c7',
  },
  settings: {
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  settingsText: {
    fontSize: 12,
    color: '#0084ff',
    fontWeight: '500',
  },
});
