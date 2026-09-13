import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Application from 'expo-application';
import {
  checkUpdate,
  downloadApk,
  installApk,
  openUnknownSourceSettings,
  type UpdateCheckResult,
  type UpdateInfo,
} from '../api/update';
import { formatBytes } from '../utils/format';

interface Props {
  /** 返回信息流 */
  onBack: () => void;
}

type DownloadPhase =
  | { state: 'idle' }
  | { state: 'downloading'; written: number; total: number }
  | { state: 'ready'; file: Awaited<ReturnType<typeof downloadApk>> }
  | { state: 'error'; message: string };

/** 关于屏：当前版本、更新检查、应用内下载安装（与顶部更新横幅同一套分发链路） */
export default function AboutScreen({ onBack }: Props) {
  const version = String(Application.nativeApplicationVersion ?? 'dev');
  const build = Number(Application.nativeBuildVersion ?? 0);

  const [check, setCheck] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(true);
  const [phase, setPhase] = useState<DownloadPhase>({ state: 'idle' });

  const runCheck = useCallback(async () => {
    setChecking(true);
    setPhase({ state: 'idle' });
    try {
      setCheck(await checkUpdate());
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  /** 下载（带进度）→ 完成后按钮变「安装」→ 拉起系统安装器 */
  const handleDownload = useCallback(async (info: UpdateInfo) => {
    setPhase({ state: 'downloading', written: 0, total: info.sizeBytes });
    try {
      const file = await downloadApk(info, (written, total) =>
        setPhase({ state: 'downloading', written, total }),
      );
      setPhase({ state: 'ready', file });
    } catch (e) {
      setPhase({ state: 'error', message: e instanceof Error ? e.message : '下载失败' });
    }
  }, []);

  const handleInstall = useCallback(async (file: Awaited<ReturnType<typeof downloadApk>>) => {
    try {
      await installApk(file);
    } catch {
      setPhase({ state: 'error', message: '无法拉起安装器，可先授予「安装未知应用」权限' });
    }
  }, []);

  const available = check?.status === 'available' ? check.info : null;
  const percent =
    phase.state === 'downloading' && phase.total > 0
      ? Math.min(100, Math.round((phase.written / phase.total) * 100))
      : null;

  return (
    <View style={styles.screen}>
      {/* 顶栏：返回 + 标题（与画像屏同款） */}
      <View style={styles.topBar}>
        <Pressable style={styles.backBtn} onPress={onBack} hitSlop={8}>
          <Text style={styles.backText}>← 返回</Text>
        </Pressable>
        <Text style={styles.topTitle}>关于</Text>
        <View style={styles.topBarSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {/* 应用标识 */}
        <View style={styles.hero}>
          <View style={styles.logoMark}>
            <Text style={styles.logoMarkText}>时</Text>
          </View>
          <Text style={styles.appName}>stories</Text>
          <Text style={styles.appDesc}>知乎 / B站抓取 · AI 打标 · 行为画像排序的个人时间线</Text>
        </View>

        {/* 版本信息 */}
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>当前版本</Text>
            <Text style={styles.rowValue}>
              v{version}
              {Number.isFinite(build) && build > 0 ? ` (build ${build})` : ''}
            </Text>
          </View>
        </View>

        {/* 更新区 */}
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>检查更新</Text>
            {checking ? (
              <ActivityIndicator size="small" color="#0084ff" />
            ) : (
              <Pressable onPress={() => void runCheck()} hitSlop={6}>
                <Text style={styles.recheck}>重新检查</Text>
              </Pressable>
            )}
          </View>

          {!checking && check && (
            <View style={styles.updateBody}>
              {check.status === 'up-to-date' && (
                <Text style={styles.upToDate}>✓ 已是最新版本</Text>
              )}
              {check.status === 'unavailable' && (
                <Text style={styles.updateHint}>
                  {check.reason === 'not-logged-in'
                    ? '未登录，无法检查更新'
                    : check.reason === 'no-release'
                      ? '服务端暂无发布信息'
                      : '网络不可用，稍后再试'}
                </Text>
              )}
              {check.status === 'available' && available && (
                <>
                  <Text style={styles.available}>
                    发现新版本 v{available.version} (build {available.versionCode}) ·{' '}
                    {available.sizeBytes > 0 ? formatBytes(available.sizeBytes) : '未知大小'}
                  </Text>
                  {phase.state === 'idle' && (
                    <Pressable style={styles.actionBtn} onPress={() => void handleDownload(available)}>
                      <Text style={styles.actionText}>下载并安装</Text>
                    </Pressable>
                  )}
                  {phase.state === 'downloading' && (
                    <View style={styles.progressWrap}>
                      <View style={styles.progressTrack}>
                        <View style={[styles.progressFill, { width: `${percent ?? 0}%` }]} />
                      </View>
                      <Text style={styles.progressText}>
                        下载中 {percent ?? 0}%
                        {available.sizeBytes > 0
                          ? `（${formatBytes(phase.written)} / ${formatBytes(phase.total)}）`
                          : ''}
                      </Text>
                    </View>
                  )}
                  {phase.state === 'ready' && (
                    <Pressable style={styles.actionBtn} onPress={() => void handleInstall(phase.file)}>
                      <Text style={styles.actionText}>安装</Text>
                    </Pressable>
                  )}
                  {phase.state === 'error' && (
                    <View style={styles.errorWrap}>
                      <Text style={styles.errorText}>✗ {phase.message}</Text>
                      <Pressable style={styles.actionBtn} onPress={() => void handleDownload(available)}>
                        <Text style={styles.actionText}>重试</Text>
                      </Pressable>
                      <Pressable hitSlop={4} onPress={() => void openUnknownSourceSettings()}>
                        <Text style={styles.settingsLink}>去授权「安装未知应用」</Text>
                      </Pressable>
                    </View>
                  )}
                </>
              )}
            </View>
          )}
        </View>

        <Text style={styles.footnote}>
          更新通过 NAS 后端分发（publish-apk.sh 发布 latest.json + APK），下载完自动校验大小后拉起系统安装器。
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#f6f6f6',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#ffffff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e8e8e8',
  },
  backBtn: {
    paddingVertical: 4,
  },
  backText: {
    fontSize: 14,
    color: '#0084ff',
  },
  topTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#121212',
    textAlign: 'center',
    flex: 1,
  },
  topBarSpacer: {
    width: 56,
  },
  body: {
    padding: 12,
    paddingBottom: 32,
    gap: 12,
  },
  hero: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 28,
    backgroundColor: '#ffffff',
    borderRadius: 12,
  },
  logoMark: {
    width: 64,
    height: 64,
    borderRadius: 16,
    backgroundColor: '#0084ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoMarkText: {
    color: '#ffffff',
    fontSize: 30,
    fontWeight: '700',
  },
  appName: {
    fontSize: 22,
    fontWeight: '700',
    color: '#121212',
  },
  appDesc: {
    fontSize: 12,
    color: '#8590a6',
    textAlign: 'center',
    paddingHorizontal: 24,
    lineHeight: 18,
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
  },
  rowLabel: {
    fontSize: 14,
    color: '#555555',
  },
  rowValue: {
    fontSize: 14,
    color: '#121212',
    fontWeight: '600',
  },
  recheck: {
    fontSize: 13,
    color: '#0084ff',
  },
  updateBody: {
    paddingBottom: 14,
    gap: 10,
  },
  upToDate: {
    fontSize: 13,
    color: '#00a67e',
  },
  updateHint: {
    fontSize: 13,
    color: '#8590a6',
  },
  available: {
    fontSize: 13,
    color: '#ad6800',
    lineHeight: 19,
  },
  actionBtn: {
    backgroundColor: '#0084ff',
    borderRadius: 20,
    paddingVertical: 9,
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 24,
  },
  actionText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  progressWrap: {
    gap: 6,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: '#eef0f3',
    overflow: 'hidden',
  },
  progressFill: {
    height: 6,
    borderRadius: 3,
    backgroundColor: '#0084ff',
  },
  progressText: {
    fontSize: 11,
    color: '#8590a6',
  },
  errorWrap: {
    gap: 8,
    alignItems: 'flex-start',
  },
  errorText: {
    fontSize: 13,
    color: '#d3382c',
  },
  settingsLink: {
    fontSize: 13,
    color: '#0084ff',
  },
  footnote: {
    fontSize: 11,
    color: '#b9c0cc',
    lineHeight: 17,
    paddingHorizontal: 4,
  },
});
