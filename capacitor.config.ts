import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize, KeyboardStyle } from '@capacitor/keyboard';

/**
 * Capacitor 壳配置：Web 仍由 Vite 构建到 dist/。
 * iOS 首次生成需在 macOS 上执行 `npx cap add ios`，或使用 .github/workflows 中的云端 bootstrap。
 * Android 首次生成在任意平台执行 `npx cap add android`（无需本机 JDK，仅打 APK 时才需要）。
 *
 * 键盘策略：交给 @capacitor/keyboard 插件用 Native resize 模式，
 * iOS 原生层把 WKWebView 高度收缩到键盘上沿，Android 原生层（android:windowSoftInputMode=adjustResize）
 * 同样让 WebView 自动缩；两端 web 层只要监听 visualViewport 同步 --app-vh / --kb-inset 即可。
 *
 * 注意：`ios.contentInset` 必须留空（默认 `'never'`），
 * 与 `Keyboard.resize: 'native'` **互斥**——前者会让 iOS 自动给 webview 加 inset，
 * 后者则在 native 层直接缩 webview frame，两套机制叠加会造成布局抖动。
 *
 * Android 端：默认 `KeyboardResize.Native` 由 @capacitor/keyboard 自动应用 adjustResize 策略，
 * 不需要再单独配置 windowSoftInputMode。
 */
const config: CapacitorConfig = {
  appId: 'com.kumiko.amadeus.app',
  appName: 'Kumiko·Amadeus',
  webDir: 'dist',
  server: {
    // 生产包内为 file/capacitor 协议加载本地 dist；开发时可取消注释并填本机 IP 做真机调试
    // url: 'http://192.168.x.x:3000',
    // cleartext: true,
    // PWA / Capacitor 都需要在通过 PC 桥接 (httpApi) 拉数据时连本机 LAN HTTP，
    // 默认放开 cleartext；A7 切完全独立后可以收紧到 networkSecurityConfig 白名单。
    cleartext: true,
    // PC HTTP 桥接 (192.168.x.x / 10.x.x.x / Tailscale 100.64.x.x) 走 fetch；
    // 这个 allowNavigation 只对 location.href 跳转生效，fetch 本身受 cleartext + CORS 控制。
    allowNavigation: ['*.local', '192.168.*.*', '10.*.*.*', '172.*.*.*', '100.*.*.*'],
  },
  ios: {
    scheme: 'kumikoamadeus',
  },
  android: {
    // 让 Chrome DevTools 能远程调试 WebView (chrome://inspect)。
    // production APK 也保留 true：debug 端口只在系统 settings > developer options
    // 打开 "USB debugging" 后才能访问，泄漏面足够小，换来用户上报问题时快速排查能力。
    webContentsDebuggingEnabled: true,
    // 把 IME 输入完整交给 WebView，避免硬键盘 / 输入法候选栏被原生层吞掉。
    // 默认就是 true，显式列出便于以后调整时知道这里有这个开关。
    captureInput: true,
  },
  plugins: {
    Keyboard: {
      resize: KeyboardResize.Native,
      style: KeyboardStyle.Light,
      resizeOnFullScreen: true,
    },
    // CapacitorHttp（A2）：把全局 fetch / XMLHttpRequest 重定向到原生 HTTP 层，
    // 绕过 WebView 的 CORS 预检。capacitor://localhost 这个伪源在 Gemini /
    // Tavily / Fish / Vocu / Open-Meteo 等 cloud API 的 CORS 白名单里都没有，
    // 不开这个就只能全部走 PC 代理；开了之后 Android 端 LLM / 联网搜索 /
    // 天气 / 节假日都能直连，A2 才能把这些功能从 PC 桥独立出来。
    //
    // 副作用：所有 fetch 都会经过 OkHttp / URLConnection 而不是 WebView。
    // - 优点：CORS-free，不发 OPTIONS 预检，请求头完全可控
    // - 注意：上传 multipart / 流式 SSE 时要测一下，CapacitorHttp 在某些
    //   边角场景的语义和 fetch 略有差异（JSON / 普通 GET / POST 完全等价）
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
