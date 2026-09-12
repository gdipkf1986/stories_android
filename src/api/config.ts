/** stories 后端公网地址。打包前可用环境变量覆盖：EXPO_PUBLIC_API_BASE=https://example.com */
export const API_BASE =
  process.env.EXPO_PUBLIC_API_BASE ?? 'https://www.johuh.dpdns.org';
