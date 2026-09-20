import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  Dimensions,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Application from 'expo-application';

type MenuId = 'likes' | 'profile' | 'about';

type Props = {
  visible: boolean;
  onClose: () => void;
  /** 打开「我喜欢」收藏屏 */
  onOpenLikes: () => void;
  /** 打开画像分析屏 */
  onOpenProfile: () => void;
  /** 打开关于屏 */
  onOpenAbout: () => void;
};

const PANEL_W = Math.min(300, Math.round(Dimensions.get('window').width * 0.78));

const ITEMS: { id: MenuId; icon: string; label: string; hint: string }[] = [
  { id: 'likes', icon: '❤️', label: '我喜欢', hint: '点过喜欢的内容 · 永不过期' },
  { id: 'profile', icon: '📊', label: '画像分析', hint: '兴趣偏好 · 可裁决' },
  { id: 'about', icon: 'ℹ️', label: '关于', hint: '版本 · 更新' },
];

/**
 * 侧滑抽屉菜单（汉堡按钮唤起）：左滑入面板 + 半透明遮罩，点遮罩/选中项关闭。
 * 自绘 Animated 实现（项目没引 react-navigation，不值得为一个抽屉引整套依赖）。
 */
export default function DrawerMenu({ visible, onClose, onOpenLikes, onOpenProfile, onOpenAbout }: Props) {
  const progress = useRef(new Animated.Value(0)).current;
  /** 挂载窗口：打开时挂载，收起动画结束后卸载（保住退场动画） */
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
    } else if (mounted) {
      Animated.timing(progress, {
        toValue: 0,
        duration: 180,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (mounted && visible) {
      Animated.timing(progress, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, visible]);

  // 硬件返回键：抽屉开着时先关抽屉（自绘抽屉没有 Modal 的 onRequestClose）
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  if (!mounted) return null;

  const version = String(Application.nativeApplicationVersion ?? 'dev');

  /** 菜单 id → 切屏回调（避免按中文 label 字符串分派） */
  const openScreen: Record<MenuId, () => void> = {
    likes: onOpenLikes,
    profile: onOpenProfile,
    about: onOpenAbout,
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="auto">
      {/* 遮罩：点按关闭 */}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: progress }]}>
        <Pressable style={styles.backdrop} onPress={onClose} />
      </Animated.View>

      {/* 左侧面板 */}
      <Animated.View
        style={[
          styles.panel,
          {
            transform: [
              {
                translateX: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-PANEL_W, 0],
                }),
              },
            ],
          },
        ]}
      >
        <View style={styles.header}>
          <View style={styles.logoMark}>
            <Text style={styles.logoMarkText}>时</Text>
          </View>
          <View style={styles.headerTextWrap}>
            <Text style={styles.appName}>stories</Text>
            <Text style={styles.appVersion}>v{version}</Text>
          </View>
        </View>

        {ITEMS.map((item) => (
          <Pressable
            key={item.label}
            style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
            onPress={() => {
              onClose();
              // 等收起动画走完再切屏，视觉上不突兀
              setTimeout(() => openScreen[item.id](), 180);
            }}
          >
            <Text style={styles.itemIcon}>{item.icon}</Text>
            <View style={styles.itemTextWrap}>
              <Text style={styles.itemLabel}>{item.label}</Text>
              <Text style={styles.itemHint}>{item.hint}</Text>
            </View>
          </Pressable>
        ))}

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            知乎 / B站抓取 · AI 打标 · 行为画像排序
          </Text>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: PANEL_W,
    backgroundColor: '#ffffff',
    elevation: 12,
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 20,
    shadowOffset: { width: 4, height: 0 },
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 22,
    paddingHorizontal: 18,
    backgroundColor: '#f6f9ff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e8e8e8',
  },
  logoMark: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#0084ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoMarkText: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '700',
  },
  headerTextWrap: {
    gap: 2,
  },
  appName: {
    fontSize: 19,
    fontWeight: '700',
    color: '#121212',
  },
  appVersion: {
    fontSize: 12,
    color: '#8590a6',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  itemPressed: {
    backgroundColor: '#f2f3f5',
  },
  itemIcon: {
    fontSize: 20,
  },
  itemTextWrap: {
    gap: 2,
  },
  itemLabel: {
    fontSize: 15,
    color: '#1a1a1a',
    fontWeight: '500',
  },
  itemHint: {
    fontSize: 11,
    color: '#a5adbb',
  },
  footer: {
    marginTop: 'auto',
    padding: 18,
  },
  footerText: {
    fontSize: 11,
    color: '#b9c0cc',
    lineHeight: 16,
  },
});
