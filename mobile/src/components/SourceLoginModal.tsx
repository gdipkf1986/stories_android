import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { fetchSourceLoginSession, requestSourceLogin } from '../api/sourceLogin';
import type { SourceId, SourceLoginSession } from '../types';

interface Props {
  source: SourceId;
  label: string;
  onClose: () => void;
}

export default function SourceLoginModal({ source, label, onClose }: Props) {
  const [requestId, setRequestId] = useState<number | null>(null);
  const [session, setSession] = useState<SourceLoginSession>({ status: 'pending' });

  const start = useCallback(async () => {
    setSession({ status: 'pending', message: '正在生成登录二维码' });
    try {
      setRequestId(await requestSourceLogin(source));
    } catch {
      setSession({ status: 'failed', message: '无法发起扫码登录', error: '请稍后重试' });
    }
  }, [source]);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => {
    if (!requestId || session.status === 'done' || session.status === 'failed' || session.status === 'expired') return;
    const timer = setInterval(() => {
      void fetchSourceLoginSession(source, requestId)
        .then(setSession)
        .catch(() => {});
    }, 2500);
    return () => clearInterval(timer);
  }, [requestId, session.status, source]);

  useEffect(() => {
    if (session.status !== 'done') return;
    const timer = setTimeout(onClose, 1600);
    return () => clearTimeout(timer);
  }, [onClose, session.status]);

  const busy = session.status === 'pending';
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{label}登录已失效</Text>
          <Text style={styles.message}>{session.message ?? '正在生成登录二维码'}</Text>

          <View style={styles.codeArea}>
            {busy ? (
              <ActivityIndicator color="#0084ff" />
            ) : session.qrDataUrl ? (
              <Image source={{ uri: session.qrDataUrl }} style={styles.qr} resizeMode="contain" />
            ) : (
              <Text style={styles.codeFallback}>{session.error ?? '暂无二维码'}</Text>
            )}
          </View>

          {(session.status === 'failed' || session.status === 'expired') && (
            <Pressable style={styles.retryButton} onPress={() => void start()}>
              <Text style={styles.retryText}>重新生成</Text>
            </Pressable>
          )}
          <Pressable style={styles.closeButton} onPress={onClose}>
            <Text style={styles.closeText}>稍后再说</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  sheet: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#fff',
    borderRadius: 18,
    padding: 20,
    alignItems: 'center',
  },
  title: { fontSize: 18, fontWeight: '700', color: '#111827' },
  message: { marginTop: 6, color: '#4b5563', textAlign: 'center' },
  codeArea: {
    width: 240,
    height: 240,
    marginTop: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: '#f8fafc',
  },
  qr: { width: 220, height: 220 },
  codeFallback: { color: '#6b7280', textAlign: 'center', paddingHorizontal: 16 },
  retryButton: { marginTop: 16, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 999, backgroundColor: '#0084ff' },
  retryText: { color: '#fff', fontWeight: '600' },
  closeButton: { marginTop: 12, paddingHorizontal: 18, paddingVertical: 10 },
  closeText: { color: '#6b7280' },
});
