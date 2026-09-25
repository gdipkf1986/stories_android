/** stories 后端公网地址。打包前可用环境变量覆盖：EXPO_PUBLIC_API_BASE=https://example.com */
export const API_BASE =
  process.env.EXPO_PUBLIC_API_BASE ?? 'https://www.johuh.dpdns.org';

/** 同一台 NAS 的局域网地址；APK 下载优先走这里，失败再回落公网。 */
export const LAN_API_BASE =
  process.env.EXPO_PUBLIC_LAN_API_BASE ?? 'http://192.168.0.89:20001';
