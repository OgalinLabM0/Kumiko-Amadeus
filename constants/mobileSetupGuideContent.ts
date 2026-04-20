// constants/mobileSetupGuideContent.ts
//
// Single source of truth for the Mobile Remote Access setup guide.
// The guide is rendered twice from this data:
//   - Inside the Settings panel via MobileSetupGuideModal.tsx (interactive,
//     with buttons that open URLs in the system browser)
//   - Mirrored as docs/mobile-setup-guide.md via
//     scripts/generate-mobile-guide-md.cjs (for GitHub / offline reading)
//
// To add or change content, edit the zh / en arrays below and run:
//     node scripts/generate-mobile-guide-md.cjs
// That regenerates the markdown mirror so the two surfaces never drift.
//
// Error codes listed in the troubleshooting table MUST stay in sync with
// the codes produced by:
//   - electron/server/tailscale-cert.cjs (runCli error classification)
//   - electron/server/fastify-server.cjs (listen EADDRINUSE capture)
//   - electron/server/mobile-access-ipc.cjs (pass-through to renderer)
// The MobileAccessSection ErrorCard keys on these codes to decide which
// section of this guide to deep-link into.

import type { Language } from '../types';

export type MobileErrorCode =
  | 'E_NO_CLI'
  | 'E_NO_HTTPS_FEATURE'
  | 'E_NOT_LOGGED_IN'
  | 'E_NO_HOSTNAME'
  | 'E_CERT_TIMEOUT'
  | 'E_CERT_FAILED'
  | 'E_LISTEN_EADDRINUSE'
  | 'E_LISTEN'
  | 'E_BUILD';

export type MobileGuideSectionId =
  | 'step0-install'
  | 'step1-https'
  | 'step2-enable'
  | 'step3-phone'
  | 'step4-errors';

export interface GuideLink {
  label: string;
  url: string;
  note?: string;
}

export interface GuideStep {
  text: string;
  note?: string;
  link?: GuideLink;
}

export interface GuideErrorRow {
  code: MobileErrorCode;
  symptom: string;
  cause: string;
  fixSteps: string[];
  actionLink?: GuideLink;
  jumpSectionId?: MobileGuideSectionId;
}

export interface GuideSection {
  id: MobileGuideSectionId;
  title: string;
  intro: string;
  steps: GuideStep[];
  errors?: GuideErrorRow[];
  tailNote?: string;
}

// Map an error code to the guide section most useful for fixing it. Used
// by the MobileAccessSection ErrorCard "查看教程" deep link.
export const ERROR_CODE_TO_SECTION: Record<MobileErrorCode, MobileGuideSectionId> = {
  E_NO_CLI: 'step0-install',
  E_NO_HTTPS_FEATURE: 'step1-https',
  E_NOT_LOGGED_IN: 'step0-install',
  E_NO_HOSTNAME: 'step0-install',
  E_CERT_TIMEOUT: 'step4-errors',
  E_CERT_FAILED: 'step4-errors',
  E_LISTEN_EADDRINUSE: 'step4-errors',
  E_LISTEN: 'step4-errors',
  E_BUILD: 'step4-errors',
};

// Helpful reference URLs — kept in one place so the markdown generator,
// the modal, and the error cards all point at the same links.
export const MOBILE_GUIDE_URLS = {
  tailscaleDownload: 'https://tailscale.com/download',
  tailscaleDownloadWindows: 'https://tailscale.com/download/windows',
  tailscaleDownloadMacos: 'https://tailscale.com/download/mac',
  tailscaleDownloadLinux: 'https://tailscale.com/download/linux',
  tailscaleDownloadIos: 'https://apps.apple.com/us/app/tailscale/id1470499037',
  tailscaleDownloadAndroid: 'https://play.google.com/store/apps/details?id=com.tailscale.ipn',
  tailscaleAdminDns: 'https://login.tailscale.com/admin/dns',
  tailscaleAdminMachines: 'https://login.tailscale.com/admin/machines',
  tailscaleHttpsDocs: 'https://tailscale.com/kb/1153/enabling-https',
  tailscaleMagicDns: 'https://tailscale.com/kb/1081/magicdns',
} as const;

export const MOBILE_SETUP_GUIDE: Record<Language, GuideSection[]> = {
  zh: [
    {
      id: 'step0-install',
      title: 'Step 0 · 在电脑和手机上安装 Tailscale',
      intro: 'Tailscale 是一条免费的私有隧道。只有登录了同一个 Tailscale 账号的设备才能互相看到，没有任何数据经过第三方服务器。电脑和手机都需要安装并登录同一个账号。',
      steps: [
        {
          text: '在电脑上下载并安装 Tailscale 客户端（Windows / macOS / Linux 都支持）。',
          note: '安装过程中会要求登录一次，用你常用的 Google / Microsoft / GitHub 账号登录即可，不需要另注册。',
          link: { label: '打开 Tailscale 官方下载页', url: MOBILE_GUIDE_URLS.tailscaleDownload },
        },
        {
          text: '在电脑上启动 Tailscale（Windows 系统托盘会出现一个 Tailscale 图标）。',
          note: '状态显示 "Connected" 才算登录成功。如果显示 "Logged out" 需要点击重新登录。',
        },
        {
          text: '在手机上安装 Tailscale App。',
          note: 'iOS 走 App Store，Android 走 Google Play（中国大陆需要连外网商店或用 APK）。安装后用和电脑相同的账号登录。',
          link: { label: 'iOS App Store', url: MOBILE_GUIDE_URLS.tailscaleDownloadIos },
        },
        {
          text: '手机上打开 Tailscale App 点一下开关启用 VPN。',
          note: '开启后手机的 Tailscale IP 会显示在 App 里（类似 100.x.x.x）。这个 VPN 不会加密你正常上网流量，只是让你能看到自己的其他设备。',
          link: { label: 'Android Google Play', url: MOBILE_GUIDE_URLS.tailscaleDownloadAndroid },
        },
      ],
      tailNote: '完成这一步之后，电脑和手机之间就能通过 Tailscale 互相看到了。下一步是让 Tailscale 给你的电脑签发一张手机能信任的 HTTPS 证书。',
    },
    {
      id: 'step1-https',
      title: 'Step 1 · 在 Tailscale 后台开启 HTTPS 证书功能（关键步骤）',
      intro: 'iOS Safari / Android Chrome 都不信任自签名证书，所以我们不能用 http:// 或自签 https://。Tailscale 提供了免费的 Let\'s Encrypt 证书签发功能，但这个功能需要你在网页管理后台手动打开一次，每个账号只需要开一次。',
      steps: [
        {
          text: '在电脑浏览器里打开 Tailscale 管理后台的 DNS 页面。',
          note: '这是整个教程最容易漏的一步 —— 如果没开这个开关，启用手机访问时会报错 "your Tailscale account does not support getting TLS certs"。',
          link: { label: '去 Tailscale Admin · DNS 页面', url: MOBILE_GUIDE_URLS.tailscaleAdminDns },
        },
        {
          text: '在页面里找到 "MagicDNS" 部分并确认它已经打开（一般默认是开的）。',
          link: { label: '什么是 MagicDNS', url: MOBILE_GUIDE_URLS.tailscaleMagicDns },
        },
        {
          text: '继续向下滚动，找到 "HTTPS Certificates" 或 "Enable HTTPS" 按钮并点击启用。',
          note: '开启后你的 tailnet 名字（xxx.ts.net）会被注册到 Let\'s Encrypt，所有在这个账号下的设备都能用 `tailscale cert` 命令领取证书。',
        },
        {
          text: '如果按钮不可点，说明你之前没有给 tailnet 起过名字。在同一页顶部有 "Tailnet name" 输入框，随便起一个英文名字后就能开了。',
        },
      ],
      tailNote: 'HTTPS Certificates 是账号级别的开关，开一次之后再也不用关心。Kumiko 下次启用手机访问时会自动调用 `tailscale cert` 命令为你的电脑签发证书。',
    },
    {
      id: 'step2-enable',
      title: 'Step 2 · 在 Kumiko 里启用手机访问，拿到地址和口令',
      intro: '前两步一次性配置，之后都不用再动。这一步是 Kumiko 本地的真正"开关"。',
      steps: [
        {
          text: '在 Kumiko 桌面版打开"设置 → 手机远程访问"面板。',
        },
        {
          text: '点击"启用手机访问"按钮。',
          note: '第一次启用会触发 Windows Defender 防火墙弹窗，选"允许"即可。Fastify 会绑定到 0.0.0.0 的一个随机高端口，只有 Tailscale 隧道内的设备能访问。',
        },
        {
          text: '等待 10-30 秒，面板会显示"运行中"并出现"连接信息"卡片。',
          note: '如果一直卡在"未运行"，看下方 Step 4 对应的错误码。',
        },
        {
          text: '把"手机访问地址"复制下来（形如 https://your-device.your-tailnet.ts.net:xxxxx/）。',
        },
        {
          text: '点"显示口令"再点"复制"，把 64 位十六进制的配对口令复制下来。',
          note: '这个口令是一次性的 —— 手机首次配对成功后就会失效。之后手机靠 Cookie 记住身份，直到你手动"吊销会话"。',
        },
      ],
    },
    {
      id: 'step3-phone',
      title: 'Step 3 · 在手机上配对并添加到主屏幕',
      intro: '手机 App 本质上是一个 PWA（Progressive Web App）—— 用系统浏览器打开桌面提供的 HTTPS 地址，然后把它"添加到主屏幕"就变成类似原生 App 的启动入口。',
      steps: [
        {
          text: '确保手机上的 Tailscale VPN 是开启状态（App 里开关打到绿色）。',
          note: '如果忘记开 VPN，会打不开 .ts.net 地址。',
        },
        {
          text: '用手机系统浏览器打开 Step 2 里复制的"手机访问地址"。',
          note: 'iOS 必须用 Safari（Chrome 也行但不能"添加到主屏幕"触发 PWA）；Android 推荐 Chrome。',
        },
        {
          text: '页面会显示 Kumiko·Amadeus Mobile 配对界面。把口令粘贴进输入框，点 Pair phone。',
          note: '成功后自动跳转到聊天界面，可以立即发消息。',
        },
        {
          text: '（可选但强烈推荐）把当前页面添加到主屏幕。',
          note: 'iOS Safari：底部分享按钮 → "添加到主屏幕"。Android Chrome：右上角菜单 → "添加到主屏幕"。之后从主屏幕启动时是独立窗口、没有浏览器地址栏，和原生 App 一样。',
        },
      ],
      tailNote: '配对成功后的 Cookie 有效期 90 天，超过 90 天或你手动"吊销会话"后需要重新粘贴口令配对。',
    },
    {
      id: 'step4-errors',
      title: 'Step 4 · 常见错误诊断',
      intro: '下面列出启用手机访问时可能遇到的错误码，以及每种错误对应的排查步骤。面板里的红色错误卡片会显示错误码，对照这张表就能知道怎么修。',
      steps: [],
      errors: [
        {
          code: 'E_NO_HTTPS_FEATURE',
          symptom: '红色错误卡片显示 "your Tailscale account does not support getting TLS certs"。',
          cause: '你的 Tailscale 账号还没开启 HTTPS Certificates 功能。这是 Tailscale 后台的一个账号级开关，必须手动打开一次。',
          fixSteps: [
            '在电脑浏览器打开下方的 Tailscale Admin · DNS 页面',
            '确认 MagicDNS 已开启',
            '找到 HTTPS Certificates 按钮点击启用',
            '回到 Kumiko 面板再次点击"启用手机访问"',
          ],
          actionLink: { label: '去 Tailscale Admin 开启 HTTPS Certificates', url: MOBILE_GUIDE_URLS.tailscaleAdminDns },
          jumpSectionId: 'step1-https',
        },
        {
          code: 'E_NO_CLI',
          symptom: '红色错误卡片显示 "tailscale CLI not found"，或 Tailscale 状态显示"未检测到 Tailscale"。',
          cause: '电脑上还没装 Tailscale 客户端，或者装了但 `tailscale.exe` 不在 PATH 里（部分 Windows 安装会这样）。',
          fixSteps: [
            '到官方下载页下载并安装 Tailscale 客户端',
            '安装后打开 Tailscale App 并登录账号',
            '系统托盘出现 Tailscale 图标且状态显示 Connected',
            '回到 Kumiko 面板重新点击"启用手机访问"',
          ],
          actionLink: { label: '打开 Tailscale 官方下载页', url: MOBILE_GUIDE_URLS.tailscaleDownload },
          jumpSectionId: 'step0-install',
        },
        {
          code: 'E_NOT_LOGGED_IN',
          symptom: 'Tailscale 状态显示"已安装但未登录/未连接"，或红色卡片提到 "backend state"。',
          cause: 'Tailscale 客户端已安装但账号没登录成功，或者 VPN 服务停止了。',
          fixSteps: [
            '打开 Tailscale 客户端',
            '确认右下角显示 Connected（绿色）而不是 Logged out / Stopped',
            '如果是 Logged out 就点 "Log in" 重新登录',
            '回到 Kumiko 面板重试',
          ],
          actionLink: { label: '查看设备连接状态', url: MOBILE_GUIDE_URLS.tailscaleAdminMachines },
        },
        {
          code: 'E_CERT_TIMEOUT',
          symptom: '启用按钮卡了 90 秒后报超时错误，面板显示"未运行"。',
          cause: 'Tailscale 客户端反应太慢、ACME 签发失败、网络不稳定，或者刚刚才开启 HTTPS Certificates 需要等几分钟让 Tailscale 后台同步。',
          fixSteps: [
            '确认电脑能正常访问互联网（不只是 Tailscale 网络）',
            '等 2-3 分钟再点一次"启用手机访问"',
            '如果连续失败超过 3 次，重启 Tailscale 客户端后再试',
            '仍然失败的话把 Step 1 的 HTTPS Certificates 按钮关掉再重新打开',
          ],
        },
        {
          code: 'E_CERT_FAILED',
          symptom: '红色卡片显示 "tailscale cert failed" 或其他 cert 相关错误。',
          cause: 'ACME 签发证书失败。常见原因是 tailnet 名字之前被 Let\'s Encrypt 限流，或者 Tailscale 后台签发配额用完了。',
          fixSteps: [
            '等 1 小时之后再重试（Let\'s Encrypt 的 rate limit 是按小时计算的）',
            '如果 1 小时后仍然失败，到 Admin 后台检查 HTTPS Certificates 开关状态',
            '仍然失败可以在 Admin 页面给你的机器起一个新名字，再触发一次签发',
          ],
          actionLink: { label: '查看 Tailscale HTTPS 文档', url: MOBILE_GUIDE_URLS.tailscaleHttpsDocs },
        },
        {
          code: 'E_LISTEN_EADDRINUSE',
          symptom: '启用时报错 "listen EADDRINUSE" 或"端口被占用"。',
          cause: '之前 Kumiko 崩溃或非正常退出，留下了一个没释放的端口。或者有别的软件占了同一个端口。',
          fixSteps: [
            '完全退出 Kumiko（托盘图标右键 → 退出）',
            '等 10 秒让系统释放端口',
            '重新打开 Kumiko，点"启用手机访问"',
            '如果仍然冲突，重启电脑让所有端口重置',
          ],
        },
        {
          code: 'E_LISTEN',
          symptom: '启用时报 "EACCES" 或其他 listen 错误（非端口占用）。',
          cause: '操作系统拒绝了绑定端口的请求，通常是防火墙或安全软件拦截。',
          fixSteps: [
            '在 Windows Defender 弹出的防火墙提示里点"允许"',
            '如果装了第三方安全软件（360、腾讯电脑管家等），临时关闭它再试',
            '确认 Kumiko 是正常安装启动，不是绿色版解压到系统目录里',
          ],
        },
        {
          code: 'E_BUILD',
          symptom: '启用时报 "E_BUILD" 或 Fastify 初始化失败。',
          cause: 'Fastify 服务本身初始化异常，通常是安装包损坏或依赖缺失。',
          fixSteps: [
            '重装最新版 Kumiko',
            '安装时选"覆盖安装"不会丢数据',
            '仍然失败可以把详细错误贴到 GitHub issue',
          ],
        },
      ],
      tailNote: '还有其他错误没列在这里？欢迎到项目 GitHub 仓库提 issue，附上红色错误卡片里的完整文本。',
    },
  ],
  en: [
    {
      id: 'step0-install',
      title: 'Step 0 · Install Tailscale on your computer and phone',
      intro: 'Tailscale is a free private tunnel. Only devices logged into the same Tailscale account can see each other — no traffic flows through third-party servers. You need Tailscale on both the desktop and the phone, signed into the same account.',
      steps: [
        {
          text: 'Download and install the Tailscale client on your computer (Windows / macOS / Linux all supported).',
          note: 'The installer asks you to log in once. Use a Google / Microsoft / GitHub account you already own — no separate signup needed.',
          link: { label: 'Open Tailscale download page', url: MOBILE_GUIDE_URLS.tailscaleDownload },
        },
        {
          text: 'Launch Tailscale on your computer (on Windows a Tailscale icon will appear in the system tray).',
          note: 'The tray should read "Connected". If it says "Logged out" click Log in.',
        },
        {
          text: 'Install the Tailscale app on your phone.',
          note: 'iOS: App Store. Android: Google Play. Sign in with the same account you used on desktop.',
          link: { label: 'iOS App Store', url: MOBILE_GUIDE_URLS.tailscaleDownloadIos },
        },
        {
          text: 'Open the Tailscale app on your phone and flip the VPN switch on.',
          note: 'Your phone will pick up a Tailscale IP (100.x.x.x). This VPN does NOT route your normal internet traffic — it only lets your own devices see each other.',
          link: { label: 'Android Google Play', url: MOBILE_GUIDE_URLS.tailscaleDownloadAndroid },
        },
      ],
      tailNote: 'Once both devices are on Tailscale, your phone can see your desktop. Next step is to let Tailscale hand out an HTTPS certificate your phone will trust.',
    },
    {
      id: 'step1-https',
      title: 'Step 1 · Enable HTTPS Certificates in the Tailscale admin (critical)',
      intro: 'iOS Safari and Android Chrome refuse self-signed certificates. Tailscale offers free Let\'s Encrypt issuance, but the feature is account-level and must be flipped on from the web admin. You only need to do this once per Tailscale account.',
      steps: [
        {
          text: 'Open the Tailscale admin DNS page in your desktop browser.',
          note: 'This is the most-missed step — skipping it means enabling Mobile Access fails with "your Tailscale account does not support getting TLS certs".',
          link: { label: 'Open Tailscale Admin · DNS', url: MOBILE_GUIDE_URLS.tailscaleAdminDns },
        },
        {
          text: 'Verify that MagicDNS is enabled (it usually is by default).',
          link: { label: 'What is MagicDNS', url: MOBILE_GUIDE_URLS.tailscaleMagicDns },
        },
        {
          text: 'Scroll down to "HTTPS Certificates" (a.k.a. "Enable HTTPS") and click to enable.',
          note: 'Enabling it registers your tailnet (xxx.ts.net) with Let\'s Encrypt. Any device in this account can then mint certificates via `tailscale cert`.',
        },
        {
          text: 'If the button is greyed out, you haven\'t named your tailnet yet. Use the "Tailnet name" input at the top of the page, pick any name, and the toggle becomes available.',
        },
      ],
      tailNote: 'HTTPS Certificates is an account-level switch — once on, you never touch it again. Next time you hit Enable in Kumiko the desktop runs `tailscale cert` on your behalf.',
    },
    {
      id: 'step2-enable',
      title: 'Step 2 · Flip Mobile Access on in Kumiko and grab the address + token',
      intro: 'The first two steps were one-time setup. This is the only part you repeat day-to-day.',
      steps: [
        {
          text: 'Open Settings → Mobile Remote Access in desktop Kumiko.',
        },
        {
          text: 'Click Enable mobile access.',
          note: 'The first enable triggers Windows Defender\'s firewall prompt — choose Allow. Fastify binds 0.0.0.0 on a random high port, only reachable through the Tailscale tunnel.',
        },
        {
          text: 'Wait 10-30 seconds until the panel reads "Running" and the Connection card appears.',
          note: 'Stuck at "Stopped"? See the Step 4 troubleshooting table for the specific error code.',
        },
        {
          text: 'Copy the Phone URL (shaped like https://your-device.your-tailnet.ts.net:xxxxx/).',
        },
        {
          text: 'Click Reveal token then Copy to grab the 64-char hex pairing token.',
          note: 'The token is one-use — once a phone pairs successfully it is invalidated. The phone remembers the session via a secure cookie (90 days) until you manually revoke it.',
        },
      ],
    },
    {
      id: 'step3-phone',
      title: 'Step 3 · Pair your phone and add to home screen',
      intro: 'The phone app is actually a PWA (Progressive Web App). You open the desktop\'s HTTPS URL in your phone\'s system browser, then "Add to Home Screen" turns it into a launcher that behaves like a native app.',
      steps: [
        {
          text: 'Make sure the Tailscale VPN on your phone is enabled (switch is green in the Tailscale app).',
          note: 'If the VPN is off the .ts.net URL will not resolve.',
        },
        {
          text: 'Open the Phone URL you copied in Step 2 in your phone\'s system browser.',
          note: 'iOS must use Safari (Chrome will load the app but cannot "Add to Home Screen" as a PWA). Android: Chrome is recommended.',
        },
        {
          text: 'The Kumiko·Amadeus Mobile pairing screen appears. Paste the token and tap Pair phone.',
          note: 'On success you\'re immediately thrown into the chat screen and can send messages right away.',
        },
        {
          text: '(Optional but strongly recommended) Add the page to your home screen.',
          note: 'iOS Safari: Share button → Add to Home Screen. Android Chrome: menu → Add to Home Screen. Launching from the home screen removes the browser chrome and feels like a native app.',
        },
      ],
      tailNote: 'Pairing cookies last 90 days. Expire or revoke-all triggers a re-pair with a fresh token.',
    },
    {
      id: 'step4-errors',
      title: 'Step 4 · Troubleshooting table',
      intro: 'Error codes you may see when enabling Mobile Access. The red error card in the Settings panel prints the code — cross-reference this table to know what to do next.',
      steps: [],
      errors: [
        {
          code: 'E_NO_HTTPS_FEATURE',
          symptom: 'Red error card says "your Tailscale account does not support getting TLS certs".',
          cause: 'Your Tailscale account hasn\'t enabled HTTPS Certificates yet. It\'s a one-time, account-level toggle in the Tailscale admin.',
          fixSteps: [
            'Open the Tailscale Admin · DNS page in your browser',
            'Confirm MagicDNS is on',
            'Scroll down and click the HTTPS Certificates toggle to enable',
            'Come back to Kumiko and click Enable mobile access again',
          ],
          actionLink: { label: 'Enable HTTPS Certificates in Tailscale admin', url: MOBILE_GUIDE_URLS.tailscaleAdminDns },
          jumpSectionId: 'step1-https',
        },
        {
          code: 'E_NO_CLI',
          symptom: 'Red error card says "tailscale CLI not found", or Tailscale status reads "Tailscale CLI not detected".',
          cause: 'Tailscale isn\'t installed on the desktop, or it is installed but `tailscale.exe` isn\'t on PATH (common on some Windows installs).',
          fixSteps: [
            'Install the Tailscale client from the official download page',
            'Open the Tailscale app after install and log in',
            'Confirm the tray icon reads Connected',
            'Come back to Kumiko and click Enable mobile access',
          ],
          actionLink: { label: 'Open Tailscale download page', url: MOBILE_GUIDE_URLS.tailscaleDownload },
          jumpSectionId: 'step0-install',
        },
        {
          code: 'E_NOT_LOGGED_IN',
          symptom: 'Status reads "installed but not logged in / connected" or the card mentions "backend state".',
          cause: 'Tailscale is installed but the account session died, or the VPN service was stopped.',
          fixSteps: [
            'Open the Tailscale client',
            'Verify the tray reads Connected (green), not Logged out / Stopped',
            'If Logged out, click Log in again',
            'Retry from Kumiko',
          ],
          actionLink: { label: 'Check device connection state', url: MOBILE_GUIDE_URLS.tailscaleAdminMachines },
        },
        {
          code: 'E_CERT_TIMEOUT',
          symptom: 'The Enable button hangs for 90 seconds and errors out; the panel shows "Stopped".',
          cause: 'Tailscale is slow, ACME issuance stalled, your network is flaky, or you just turned on HTTPS Certificates and the backend hasn\'t propagated yet.',
          fixSteps: [
            'Confirm the computer has working internet (not just Tailscale)',
            'Wait 2-3 minutes and click Enable again',
            'If it fails 3+ times, restart the Tailscale client and retry',
            'Still failing? Toggle HTTPS Certificates off and back on from the admin',
          ],
        },
        {
          code: 'E_CERT_FAILED',
          symptom: 'Red card reads "tailscale cert failed" or similar cert issuance error.',
          cause: 'ACME issuance failed. Usually Let\'s Encrypt rate-limited the tailnet or the quota is temporarily exhausted.',
          fixSteps: [
            'Wait an hour and retry (Let\'s Encrypt rate limits reset hourly)',
            'After waiting, check the HTTPS Certificates toggle in admin',
            'As a last resort rename the machine in admin and retry',
          ],
          actionLink: { label: 'Read Tailscale HTTPS docs', url: MOBILE_GUIDE_URLS.tailscaleHttpsDocs },
        },
        {
          code: 'E_LISTEN_EADDRINUSE',
          symptom: 'Error reads "listen EADDRINUSE" or "port in use".',
          cause: 'A previous crash of Kumiko left the port bound, or another app is using the same port.',
          fixSteps: [
            'Fully quit Kumiko (tray → Quit)',
            'Wait 10 seconds for the OS to release the port',
            'Re-open Kumiko and click Enable',
            'If still conflicting, reboot to reset all port bindings',
          ],
        },
        {
          code: 'E_LISTEN',
          symptom: 'Error reads "EACCES" or other listen error (not a port conflict).',
          cause: 'The OS refused the bind, usually a firewall or security suite blocking it.',
          fixSteps: [
            'Accept the Windows Defender firewall prompt (click Allow)',
            'If you run a 3rd-party AV (360, Norton, etc.), temporarily disable it and retry',
            'Make sure Kumiko was properly installed, not extracted into a system directory',
          ],
        },
        {
          code: 'E_BUILD',
          symptom: 'Error reads "E_BUILD" or Fastify initialization failed.',
          cause: 'Fastify itself failed to start, usually a corrupted install or missing dependency.',
          fixSteps: [
            'Reinstall the latest Kumiko build',
            'Choose "overwrite" during install — your data is preserved',
            'Still failing? File an issue on GitHub with the full error text',
          ],
        },
      ],
      tailNote: 'Hit an error not listed here? Please open a GitHub issue and paste the full contents of the red error card so we can add it to the table.',
    },
  ],
};

// Convenience lookup for components that have a language + section id in
// hand. Returns `null` if either is missing instead of throwing so the
// caller can render a graceful fallback.
export function findMobileGuideSection(
  language: Language,
  id: MobileGuideSectionId,
): GuideSection | null {
  const list = MOBILE_SETUP_GUIDE[language] || MOBILE_SETUP_GUIDE.zh;
  return list.find((s) => s.id === id) || null;
}
