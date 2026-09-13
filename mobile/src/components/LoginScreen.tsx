import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { login } from '../api/auth';

/** 登录页：访问密码 → POST /auth/login → token 持久化后回调 */
export default function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!password || busy) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await login(password);
      onLogin();
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败');
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.card}>
        <View style={styles.logo}>
          <Text style={styles.logoText}>时</Text>
        </View>
        <Text style={styles.title}>stories</Text>
        <Text style={styles.subtitle}>请输入访问密码</Text>

        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="访问密码"
          placeholderTextColor="#a5adbb"
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={submit}
        />
        <Pressable
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed, busy && styles.btnBusy]}
          onPress={submit}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={styles.btnText}>登 录</Text>
          )}
        </Pressable>
        {!!error && <Text style={styles.error}>{error}</Text>}
      </View>
      <Text style={styles.version}>v{Constants.expoConfig?.version ?? '?'}</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#f6f6f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    width: '86%',
    maxWidth: 360,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 28,
    alignItems: 'center',
    elevation: 2,
  },
  logo: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#0084ff',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  logoText: {
    color: '#ffffff',
    fontSize: 22,
    fontWeight: '700',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#121212',
  },
  subtitle: {
    marginTop: 6,
    fontSize: 13,
    color: '#8590a6',
  },
  version: {
    position: 'absolute',
    bottom: 12,
    fontSize: 12,
    color: '#a5adbb',
  },
  input: {
    width: '100%',
    marginTop: 20,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#dcdfe4',
    borderRadius: 10,
    color: '#121212',
  },
  btn: {
    width: '100%',
    marginTop: 14,
    paddingVertical: 13,
    borderRadius: 10,
    backgroundColor: '#0084ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPressed: {
    opacity: 0.9,
  },
  btnBusy: {
    opacity: 0.6,
  },
  btnText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  error: {
    marginTop: 12,
    fontSize: 13,
    color: '#d0342c',
  },
});
