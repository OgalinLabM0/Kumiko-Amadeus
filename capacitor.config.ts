import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize, KeyboardStyle } from '@capacitor/keyboard';

/**
 * Capacitor 壳配置：Web 仍由 Vite 构建到 dist/。
 * iOS 首次生成需在 macOS 上执行 `npx cap add ios`，或使用 .github/workflows 中的云端 bootstrap。
 * Android 首次生成在任意平台执行 `npx cap add android`（无需本机 JDK，仅打 APK 时才需要）。
 *
 * 键盘策略（F2A.2 切到 None）：
 *   原本 `KeyboardResize.Native` 让原生层把 WebView 高度收缩到键盘上沿。Android 上配合
 *   `android:windowSoftInputMode=adjustResize` 会直接缩 WebView frame —— 副作用是
 *   AppMainView 里 `<div className="absolute inset-0 ...">` 包的立绘也跟着缩，
 *   于是用户感觉「立绘被键盘顶上去」。
 *
 *   现在改 `KeyboardResize.None`：原生层不动 WebView 高度，由 web 层监听
 *   `window.visualViewport` 的 height 变化自己算 `--kb-inset`（已经在 useViewportSync 里）
 *   并把 footer / chat list 的 padding-bottom 推到键盘上沿。立绘所在的 inset-0 容器不缩，
 *   原地不动。
 *
 *   iOS 风险：Apple 文档明确说 WKWebView 在 ContentInset 默认 'never' + Keyboard.resize=None
 *   场景下需要 web 层自己处理键盘遮挡。我们已经走 visualViewport 这套，逻辑跟 Android 一致。
 *   目前 iOS 还没出包；将来加 iOS 时如果发现行为不一致再分平台 override。
 *
 * Android 端：`KeyboardResize.None` 不会调 adjustResize（插件默认在 None 模式下设
 * `windowSoftInputMode=adjustNothing` + 让 WebView 接管 IME 事件），不需要再单独配置。
 */
const config: CapacitorConfig = {
  appId: 'com.kumiko.amadeus.app',
  appName: 'Kumiko·Amadeus',
  webDir: 'dist',
  server: {
    // 生产包内为 file/capacitor 协议加载本地 dist；开发时可取消注释并填本机 IP 做真机调试
    // url: 'http://192.168.x.x:3000',
    // F2B.3: PWA → PC 桥接已删除 (services/httpApi.ts gone)，APK 走 CapacitorHttp
    // 直连云端 LLM/TTS/embedding 提供商。cleartext 暂时保留以便真机调试期间直连
    // dev server，发版前如果想最严格可以收紧到 networkSecurityConfig 白名单。
    cleartext: true,
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
    // v2.14.20: 用户实测外接蓝牙键盘在其它 Android app 可正常输入中文，
    // 但在本 WebView 内无论怎么切换都会变英文。这里不再强制 Capacitor
    // capture hardware input, 让系统 IME 正常接管硬键盘组合/候选栏。
    // 独立 commit: 若软键盘输入出现回归, 可单独 revert 这一行。
    captureInput: false,
  },
  plugins: {
    Keyboard: {
      // F2A.2: was Native — caused立绘 to shift up because Android shrinks
      // the WebView frame on adjustResize, which collapses the absolute
      // inset-0 container holding the avatar. None keeps the WebView at
      // full height; visualViewport + useViewportSync push the footer
      // padding-bottom up to the keyboard top edge.
      resize: KeyboardResize.None,
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
