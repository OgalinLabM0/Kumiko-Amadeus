import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize, KeyboardStyle } from '@capacitor/keyboard';

/**
 * Capacitor 壳配置：Web 仍由 Vite 构建到 dist/。
 * iOS 首次生成需在 macOS 上执行 `npx cap add ios`，或使用 .github/workflows 中的云端 bootstrap。
 *
 * 键盘策略：交给 @capacitor/keyboard 插件用 Native resize 模式，
 * 由 iOS 原生层把 WKWebView 高度收缩到键盘上沿，等价于 visualViewport.height 实时反馈。
 * 这样 web 层只要监听 visualViewport 同步 --app-vh 即可，不会再出现底部白条 / 露 iOS 灰背景。
 *
 * 注意：`ios.contentInset` 必须留空（默认 `'never'`），
 * 与 `Keyboard.resize: 'native'` **互斥**——前者会让 iOS 自动给 webview 加 inset，
 * 后者则在 native 层直接缩 webview frame，两套机制叠加会造成布局抖动。
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
    scheme: 'kumikoamadeus',
  },
  plugins: {
    Keyboard: {
      resize: KeyboardResize.Native,
      style: KeyboardStyle.Light,
      resizeOnFullScreen: true,
    },
  },
};

export default config;
