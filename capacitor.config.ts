import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 壳配置：Web 仍由 Vite 构建到 dist/。
 * iOS 首次生成需在 macOS 上执行 `npx cap add ios`，或使用 .github/workflows 中的云端 bootstrap。
 */
const config: CapacitorConfig = {
  appId: 'com.kumiko.amadeus.app',
  appName: 'Kumiko Amadeus',
  webDir: 'dist',
  server: {
    // 生产包内为 file/capacitor 协议加载本地 dist；开发时可取消注释并填本机 IP 做真机调试
    // url: 'http://192.168.x.x:3000',
    // cleartext: true,
  },
  ios: {
    contentInset: 'automatic',
    scheme: 'kumikoamadeus',
  },
};

export default config;
