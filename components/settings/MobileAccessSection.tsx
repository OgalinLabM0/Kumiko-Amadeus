// components/settings/MobileAccessSection.tsx
//
// Desktop-only Settings section for the Mobile Remote Access feature.
// Surfaces the enable toggle, the Tailscale MagicDNS hostname (once
// available), the pairing token (reveal + copy + rotate), structured
// error cards that deep-link into the setup guide, and a dedicated
// "open full guide" button that spawns MobileSetupGuideModal.
//
// All external URLs (Tailscale admin, download page, docs) are routed
// through utils/openExternal.ts so they open in the user's real browser
// rather than inside the Electron BrowserWindow — critical for the admin
// console since it requires an existing Tailscale login session.
//
// See docs/mobile-setup-guide.md (generated from
// constants/mobileSetupGuideContent.ts) for the user-facing tutorial.

import React, { useCallback, useEffect, useState } from 'react';
import {
  Smartphone,
  ChevronDown,
  ChevronUp,
  Copy,
  RefreshCw,
  ShieldOff,
  ExternalLink,
  Book,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
} from 'lucide-react';
import { Language } from '../../types';
import { openExternalUrl } from '../../utils/openExternal';
import {
  ERROR_CODE_TO_SECTION,
  MOBILE_GUIDE_URLS,
  type MobileErrorCode,
  type MobileGuideSectionId,
} from '../../constants/mobileSetupGuideContent';
import { MobileSetupGuideModal } from './MobileSetupGuideModal';

// The global `Window.electronAPI` typing lives in types.ts. We avoid
// redeclaring it here — Phase 1 only needs `invoke`, and the existing
// declaration already describes a compatible signature.

interface MobileAccessState {
  ok: boolean;
  enabled: boolean;
  running: boolean;
  hasPairingToken: boolean;
  pairingTokenCreatedAt: number | null;
  activeSessionCount: number;
  tailscale: {
    ok: boolean;
    code: string | null;
    message: string | null;
    hostname: string | null;
    ipv4: string | null;
    tailnet: string | null;
  };
  server: {
    port: number;
    hostname: string;
    ipv4: string | null;
    url: string;
    certExpiresAt: string | null;
  } | null;
}

interface MobileAccessError {
  code: string | null;
  message: string;
}

interface MobileAccessSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  language: Language;
}

const COPY = {
  zh: {
    title: '手机远程访问',
    desc: '在手机上通过 Tailscale 私有通道访问桌面版。第一次启用前请先看"查看完整教程"。',
    notDesktop: '当前不在桌面版运行，无法启用此功能。',
    statusHeadline: '服务状态',
    enabledOn: '已启用',
    enabledOff: '未启用',
    runningYes: '运行中',
    runningNo: '未运行',
    toggleEnable: '启用手机访问',
    toggleDisable: '停用手机访问',
    tailscaleSectionTitle: 'Tailscale 状态',
    tailscaleNotInstalled: '未检测到 Tailscale。需要在电脑上安装并登录 Tailscale，然后回到这里重试。',
    tailscaleNotLoggedIn: '已安装 Tailscale，但尚未登录/未连接。',
    tailscaleNoHostname: 'Tailscale 未返回 MagicDNS 域名，请检查网络。',
    tailscaleOk: '连接正常',
    installGuide: '前往 Tailscale 下载页',
    connectionTitle: '连接信息',
    hostnameLabel: '手机访问地址',
    ipv4Label: 'Tailscale IP',
    tokenTitle: '配对口令',
    tokenMissing: '尚未生成配对口令，启用后自动生成。',
    tokenReveal: '显示口令',
    tokenHide: '隐藏',
    tokenCopy: '复制',
    tokenCopied: '已复制',
    tokenRotate: '更换口令',
    tokenRotateHint: '更换后需要在手机上重新配对。',
    sessionsTitle: '已配对的会话',
    sessionsCount: '个活跃会话',
    revokeAll: '吊销所有会话',
    revokeHint: '吊销后所有手机都要重新粘贴口令配对。',
    loading: '读取中…',
    guideButton: '查看完整教程',
    errorTitleGeneric: '操作失败',
    errorSymptomLabel: '错误码',
    errorMessageLabel: '详细信息',
    errorHintLabel: '怎么修',
    errorActionAdmin: '去 Tailscale Admin 开启 HTTPS Certificates',
    errorActionDownload: '去下载并安装 Tailscale',
    errorActionTutorial: '查看教程对应章节',
  },
  en: {
    title: 'Mobile Remote Access',
    desc: 'Reach the desktop app from your phone over a private Tailscale tunnel. Read "View full guide" before your first enable.',
    notDesktop: 'This section is available in the desktop build only.',
    statusHeadline: 'Service status',
    enabledOn: 'Enabled',
    enabledOff: 'Disabled',
    runningYes: 'Running',
    runningNo: 'Stopped',
    toggleEnable: 'Enable mobile access',
    toggleDisable: 'Disable mobile access',
    tailscaleSectionTitle: 'Tailscale status',
    tailscaleNotInstalled: 'Tailscale CLI not detected. Install and log in to Tailscale on this desktop, then retry.',
    tailscaleNotLoggedIn: 'Tailscale is installed but not logged in / connected.',
    tailscaleNoHostname: 'Tailscale returned no MagicDNS hostname. Check the network.',
    tailscaleOk: 'Connected',
    installGuide: 'Open Tailscale download page',
    connectionTitle: 'Connection',
    hostnameLabel: 'Phone URL',
    ipv4Label: 'Tailscale IP',
    tokenTitle: 'Pairing token',
    tokenMissing: 'No pairing token yet — enabling mobile access will create one.',
    tokenReveal: 'Reveal token',
    tokenHide: 'Hide',
    tokenCopy: 'Copy',
    tokenCopied: 'Copied',
    tokenRotate: 'Rotate token',
    tokenRotateHint: 'Rotating forces every paired phone to re-enter the new token.',
    sessionsTitle: 'Paired sessions',
    sessionsCount: 'active',
    revokeAll: 'Revoke all sessions',
    revokeHint: 'Revokes every paired phone; they will have to re-pair.',
    loading: 'Loading…',
    guideButton: 'View full guide',
    errorTitleGeneric: 'Action failed',
    errorSymptomLabel: 'Code',
    errorMessageLabel: 'Details',
    errorHintLabel: 'How to fix',
    errorActionAdmin: 'Open Tailscale admin to enable HTTPS',
    errorActionDownload: 'Download and install Tailscale',
    errorActionTutorial: 'Jump to tutorial section',
  },
} as const;

// Human-readable headline per error code. Displayed above the raw error
// message inside ErrorCard.
const ERROR_HEADLINE: Record<string, { zh: string; en: string }> = {
  E_NO_HTTPS_FEATURE: {
    zh: 'Tailscale 账户未开启 HTTPS 证书功能',
    en: 'Your Tailscale account has HTTPS Certificates disabled',
  },
  E_NO_CLI: {
    zh: '电脑上未检测到 Tailscale',
    en: 'Tailscale CLI not installed on this computer',
  },
  E_NOT_LOGGED_IN: {
    zh: 'Tailscale 尚未登录/未连接',
    en: 'Tailscale is not logged in',
  },
  E_NO_HOSTNAME: {
    zh: 'Tailscale 没返回 MagicDNS 域名',
    en: 'Tailscale did not return a MagicDNS hostname',
  },
  E_CERT_TIMEOUT: {
    zh: '签发证书超时',
    en: 'Certificate issuance timed out',
  },
  E_CERT_FAILED: {
    zh: '签发证书失败',
    en: 'Certificate issuance failed',
  },
  E_LISTEN_EADDRINUSE: {
    zh: '端口被占用，无法启动服务',
    en: 'Port is in use — server failed to start',
  },
  E_LISTEN: {
    zh: '系统拒绝绑定端口',
    en: 'OS refused to bind the listen port',
  },
  E_BUILD: {
    zh: 'Fastify 初始化失败',
    en: 'Fastify failed to initialize',
  },
};

const ERROR_HINT: Record<string, { zh: string; en: string }> = {
  E_NO_HTTPS_FEATURE: {
    zh: '打开 Tailscale 管理后台的 DNS 页面 → 滚到底部 → 开启 "HTTPS Certificates" 开关。整个账号只需要开一次。',
    en: 'Open the Tailscale admin DNS page, scroll to the bottom, and flip the "HTTPS Certificates" toggle on. This is a one-time, account-level setting.',
  },
  E_NO_CLI: {
    zh: '到 Tailscale 官方下载页下载并安装客户端，安装后登录账号，托盘出现 Tailscale 图标后再回来重试。',
    en: 'Install Tailscale from the official download page, sign in, and wait for the tray icon to show Connected before retrying.',
  },
  E_NOT_LOGGED_IN: {
    zh: '打开 Tailscale 客户端确认状态是 Connected（绿色），若是 Logged out 就重新登录，再回到这里重试。',
    en: 'Open Tailscale, verify the tray reads Connected, and retry. Click Log in if it shows Logged out.',
  },
  E_NO_HOSTNAME: {
    zh: '检查电脑网络连接，然后重启 Tailscale 客户端。仍然失败可到 Admin 后台 DNS 页面确认 MagicDNS 已开启。',
    en: 'Check your internet connection, restart the Tailscale client, and retry. Verify MagicDNS is enabled in the admin DNS page.',
  },
  E_CERT_TIMEOUT: {
    zh: '等 2-3 分钟后再点一次启用。如果你刚刚才开启 HTTPS Certificates，后台可能还在同步。',
    en: 'Wait 2-3 minutes and click Enable again. If you just turned on HTTPS Certificates, the backend may still be propagating.',
  },
  E_CERT_FAILED: {
    zh: 'ACME 签发失败，一般是临时限流。等 1 小时后重试，或在 Admin 后台确认 HTTPS Certificates 开关状态。',
    en: 'ACME issuance failed, usually a temporary rate limit. Wait an hour and retry; verify HTTPS Certificates is still enabled in admin.',
  },
  E_LISTEN_EADDRINUSE: {
    zh: '完全退出 Kumiko（托盘右键 → 退出），等 10 秒后重新打开再启用。',
    en: 'Fully quit Kumiko (tray → Quit), wait 10 seconds, reopen and retry.',
  },
  E_LISTEN: {
    zh: '在 Windows Defender 防火墙弹窗里点"允许"。如果装了第三方安全软件，临时关闭后再试。',
    en: 'Allow Kumiko in the Windows Defender firewall prompt. Temporarily disable any third-party security suite and retry.',
  },
  E_BUILD: {
    zh: 'Fastify 自身初始化异常。建议重装最新版 Kumiko（覆盖安装不会丢数据）。',
    en: 'Fastify itself failed to start. Reinstall the latest Kumiko build (overwrite install preserves data).',
  },
};

function formatDate(ts: number | null): string {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(); } catch { return ''; }
}

function invokeMobileAccess<T = unknown>(channel: string, data?: unknown): Promise<T> {
  if (typeof window === 'undefined' || !window.electronAPI?.invoke) {
    return Promise.reject(new Error('electronAPI unavailable'));
  }
  return window.electronAPI.invoke(channel, data) as Promise<T>;
}

interface ErrorCardProps {
  error: MobileAccessError;
  language: Language;
  isDarkMode: boolean;
  onOpenGuide: (sectionId?: MobileGuideSectionId) => void;
}

// Structured error display: headline + code + raw message + fix hint +
// two action buttons. Shown in place of the old red one-liner so the
// user isn't left staring at a stack trace.
const ErrorCard: React.FC<ErrorCardProps> = ({ error, language, isDarkMode, onOpenGuide }) => {
  const t = COPY[language];
  const code = (error.code || '').toUpperCase();
  const headline = ERROR_HEADLINE[code] ? ERROR_HEADLINE[code][language] : t.errorTitleGeneric;
  const hint = ERROR_HINT[code] ? ERROR_HINT[code][language] : null;
  const tutorialSection = ERROR_CODE_TO_SECTION[code as MobileErrorCode] || 'step4-errors';

  // Determine which admin/download URL (if any) to surface based on code.
  const primaryAction: { label: string; url: string } | null =
    code === 'E_NO_HTTPS_FEATURE'
      ? { label: t.errorActionAdmin, url: MOBILE_GUIDE_URLS.tailscaleAdminDns }
      : code === 'E_NO_CLI'
        ? { label: t.errorActionDownload, url: MOBILE_GUIDE_URLS.tailscaleDownload }
        : code === 'E_NOT_LOGGED_IN'
          ? { label: t.errorActionAdmin.replace('HTTPS Certificates', 'Machines').replace('HTTPS', 'Machines'), url: MOBILE_GUIDE_URLS.tailscaleAdminMachines }
          : null;

  const containerClass = isDarkMode
    ? 'rounded-[0.85rem] border border-red-800/60 bg-red-950/25 p-3 text-red-100'
    : 'rounded-[0.85rem] border border-red-300 bg-red-50 p-3 text-red-900';
  const codeChipClass = isDarkMode
    ? 'inline-block rounded px-2 py-0.5 font-mono text-[11px] bg-red-900/60 text-red-100'
    : 'inline-block rounded px-2 py-0.5 font-mono text-[11px] bg-red-200 text-red-900';
  const labelClass = isDarkMode ? 'text-red-200/80' : 'text-red-800/80';
  const buttonClassPrimary = isDarkMode
    ? 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[0.65rem] border border-red-400 bg-red-500/20 text-red-100 hover:bg-red-500/35 transition-colors text-sm'
    : 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[0.65rem] border border-red-400 bg-white text-red-700 hover:bg-red-100 transition-colors text-sm';
  const buttonClassSecondary = isDarkMode
    ? 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[0.65rem] border border-red-800/60 bg-red-950/40 text-red-200 hover:bg-red-900/50 transition-colors text-sm'
    : 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[0.65rem] border border-red-300 bg-red-50 text-red-700 hover:bg-red-100 transition-colors text-sm';

  return (
    <div className={containerClass}>
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[14.5px]">{headline}</div>
          {code && (
            <div className="mt-1 flex items-center gap-2 flex-wrap text-[12px]">
              <span className={labelClass}>{t.errorSymptomLabel}:</span>
              <span className={codeChipClass}>{code}</span>
            </div>
          )}
          {error.message && (
            <div className="mt-1.5 text-[12.5px] leading-5 break-words">
              <span className={labelClass}>{t.errorMessageLabel}:</span>{' '}
              <span className="font-mono opacity-85">{error.message}</span>
            </div>
          )}
          {hint && (
            <div className="mt-2 text-[13px] leading-5">
              <span className={`${labelClass} font-semibold`}>{t.errorHintLabel}:</span>{' '}
              {hint}
            </div>
          )}
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            {primaryAction && (
              <button
                type="button"
                onClick={() => openExternalUrl(primaryAction.url)}
                className={buttonClassPrimary}
              >
                <ExternalLink size={12} />
                {primaryAction.label}
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenGuide(tutorialSection)}
              className={buttonClassSecondary}
            >
              <ArrowRight size={12} />
              {t.errorActionTutorial}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export const MobileAccessSection: React.FC<MobileAccessSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  language,
}) => {
  const t = COPY[language] || COPY.zh;
  const isDesktop = typeof window !== 'undefined' && 'electronAPI' in window;

  const [state, setState] = useState<MobileAccessState | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [justCopied, setJustCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<MobileAccessError | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideInitialSection, setGuideInitialSection] = useState<MobileGuideSectionId | undefined>(undefined);

  const openGuide = useCallback((sectionId?: MobileGuideSectionId) => {
    setGuideInitialSection(sectionId);
    setGuideOpen(true);
  }, []);

  const closeGuide = useCallback(() => {
    setGuideOpen(false);
  }, []);

  const refresh = useCallback(async () => {
    if (!isDesktop) return;
    try {
      const result = await invokeMobileAccess<MobileAccessState>('mobile-access:get-state');
      setState(result);
    } catch (e) {
      setError({ code: null, message: (e as Error).message });
    }
  }, [isDesktop]);

  useEffect(() => {
    if (isOpen) {
      refresh();
    }
  }, [isOpen, refresh]);

  const handleEnable = useCallback(async () => {
    setBusy('enable');
    setError(null);
    try {
      const result = await invokeMobileAccess<{ ok: boolean; error?: string; code?: string; state?: MobileAccessState }>(
        'mobile-access:enable',
      );
      if (!result.ok) {
        setError({ code: result.code || null, message: result.error || 'enable failed' });
      }
      await refresh();
    } catch (e) {
      setError({ code: null, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const handleDisable = useCallback(async () => {
    setBusy('disable');
    setError(null);
    try {
      await invokeMobileAccess<{ ok: boolean }>('mobile-access:disable');
      setToken(null);
      setShowToken(false);
      await refresh();
    } catch (e) {
      setError({ code: null, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const handleRevealToken = useCallback(async () => {
    setBusy('token');
    setError(null);
    try {
      const result = await invokeMobileAccess<{ ok: boolean; token?: string; error?: string; code?: string }>(
        'mobile-access:get-pairing-token',
      );
      if (result.ok && result.token) {
        setToken(result.token);
        setShowToken(true);
      } else {
        setError({ code: result.code || null, message: result.error || 'no token available' });
      }
    } catch (e) {
      setError({ code: null, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }, []);

  const handleCopyToken = useCallback(async () => {
    if (!token) return;
    try {
      await navigator.clipboard?.writeText(token);
      setJustCopied(true);
      setTimeout(() => setJustCopied(false), 1500);
    } catch {
      setError({ code: null, message: 'clipboard copy failed' });
    }
  }, [token]);

  const handleRotateToken = useCallback(async () => {
    setBusy('rotate');
    setError(null);
    try {
      const result = await invokeMobileAccess<{ ok: boolean; token?: string; error?: string; code?: string }>(
        'mobile-access:rotate-token',
      );
      if (result.ok && result.token) {
        setToken(result.token);
        setShowToken(true);
      } else {
        setError({ code: result.code || null, message: result.error || 'rotate failed' });
      }
      await refresh();
    } catch (e) {
      setError({ code: null, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const handleRevokeAll = useCallback(async () => {
    setBusy('revoke');
    setError(null);
    try {
      await invokeMobileAccess<{ ok: boolean }>('mobile-access:revoke-sessions');
      await refresh();
    } catch (e) {
      setError({ code: null, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const sectionBorder = isDarkMode
    ? 'border-[#4a3728]/65 bg-[linear-gradient(180deg,rgba(33,25,19,0.9),rgba(18,14,11,0.94))] shadow-[0_18px_40px_rgba(0,0,0,0.24)]'
    : 'border-[#e6ddd0]/90 bg-[rgba(255,255,255,0.82)] shadow-[0_8px_18px_rgba(44,33,22,0.025)]';
  const titleClass = isDarkMode ? 'text-yellow-500' : 'text-[#9c7425]';
  const mutedClass = isDarkMode ? 'text-[#b8a78f]' : 'text-[#7d6951]';
  const cardClass = isDarkMode
    ? 'rounded-[0.85rem] border border-[#443324] bg-[linear-gradient(180deg,rgba(24,18,13,0.84),rgba(16,12,10,0.78))] p-3'
    : 'rounded-[0.85rem] border border-[#ebe1d3] bg-[rgba(255,255,255,0.92)] p-3';
  const btnClass = isDarkMode
    ? 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[0.65rem] border border-[#58422d]/60 bg-white/[0.03] text-[#eadccf] hover:bg-white/[0.07] transition-colors text-sm disabled:opacity-50'
    : 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[0.65rem] border border-[#e4dbcf] bg-white text-[#6d5d49] hover:bg-[#faf8f4] transition-colors text-sm disabled:opacity-50';
  const primaryBtnClass = isDarkMode
    ? 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[0.65rem] border border-yellow-600/60 bg-yellow-700/30 text-yellow-100 hover:bg-yellow-700/50 transition-colors text-sm disabled:opacity-50'
    : 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[0.65rem] border border-[#c59142] bg-[#fff4e0] text-[#7d5b12] hover:bg-[#fdeac4] transition-colors text-sm disabled:opacity-50';
  const dangerBtnClass = isDarkMode
    ? 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[0.65rem] border border-red-700/60 bg-red-900/30 text-red-100 hover:bg-red-900/50 transition-colors text-sm disabled:opacity-50'
    : 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[0.65rem] border border-red-400 bg-red-50 text-red-700 hover:bg-red-100 transition-colors text-sm disabled:opacity-50';

  const tailscale = state?.tailscale;
  const tailscaleStatusMessage = !tailscale
    ? t.loading
    : tailscale.ok
      ? t.tailscaleOk
      : tailscale.code === 'E_NO_CLI'
        ? t.tailscaleNotInstalled
        : tailscale.code === 'E_NOT_LOGGED_IN'
          ? t.tailscaleNotLoggedIn
          : tailscale.code === 'E_NO_HOSTNAME'
            ? t.tailscaleNoHostname
            : tailscale.message || t.tailscaleNotLoggedIn;

  const serverUrl = state?.server?.url || (tailscale?.hostname && state?.server?.port
    ? `https://${tailscale.hostname}:${state.server.port}/`
    : null);

  return (
    <section className={`rounded-[1.2rem] border ${sectionBorder} overflow-hidden`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 px-4 py-3"
      >
        <span className="flex items-center gap-2">
          <Smartphone size={18} className={titleClass} />
          <span className={`font-semibold ${titleClass}`}>{t.title}</span>
        </span>
        {isOpen ? <ChevronUp size={16} className={mutedClass} /> : <ChevronDown size={16} className={mutedClass} />}
      </button>

      {isOpen && (
        <div className="px-4 pb-4 space-y-3">
          {/* Phase 7 Part t13_settings_sections: on narrow settings panels
              the `min-w-[240px]` on the description forced the guide
              button to overflow horizontally. Drop to 180px so 320px
              phones still wrap neatly; sm: restores the 240px target. */}
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <p className={`text-sm ${mutedClass} flex-1 min-w-[180px] sm:min-w-[240px]`}>{t.desc}</p>
            <button
              type="button"
              onClick={() => openGuide()}
              className={primaryBtnClass + ' active:scale-95'}
            >
              <Book size={14} />
              {t.guideButton}
            </button>
          </div>

          {!isDesktop ? (
            <div className={`${cardClass} text-sm ${mutedClass}`}>{t.notDesktop}</div>
          ) : (
            <>
              {/* Service status */}
              <div className={cardClass}>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-sm">
                    <div className={titleClass + ' font-semibold'}>{t.statusHeadline}</div>
                    <div className={mutedClass}>
                      {state
                        ? `${state.enabled ? t.enabledOn : t.enabledOff} · ${state.running ? t.runningYes : t.runningNo}`
                        : t.loading}
                    </div>
                  </div>
                  {state?.enabled ? (
                    <button
                      onClick={handleDisable}
                      disabled={busy === 'disable'}
                      className={dangerBtnClass}
                    >
                      <ShieldOff size={14} />
                      {busy === 'disable' ? t.loading : t.toggleDisable}
                    </button>
                  ) : (
                    <button
                      onClick={handleEnable}
                      disabled={busy === 'enable'}
                      className={primaryBtnClass}
                    >
                      <Smartphone size={14} />
                      {busy === 'enable' ? t.loading : t.toggleEnable}
                    </button>
                  )}
                </div>
              </div>

              {/* Tailscale status */}
              <div className={cardClass}>
                <div className={titleClass + ' font-semibold text-sm mb-1'}>{t.tailscaleSectionTitle}</div>
                <div className={`text-sm ${mutedClass} flex items-center gap-2`}>
                  {tailscale?.ok && <CheckCircle2 size={14} className={isDarkMode ? 'text-emerald-400' : 'text-emerald-600'} />}
                  {tailscaleStatusMessage}
                </div>
                {tailscale?.code === 'E_NO_CLI' && (
                  <button
                    type="button"
                    onClick={() => openExternalUrl(MOBILE_GUIDE_URLS.tailscaleDownload)}
                    className={btnClass + ' mt-2'}
                  >
                    <ExternalLink size={12} />
                    {t.installGuide}
                  </button>
                )}
              </div>

              {/* Connection info */}
              {state?.enabled && state.running && serverUrl && (
                <div className={cardClass}>
                  <div className={titleClass + ' font-semibold text-sm mb-1'}>{t.connectionTitle}</div>
                  <div className={`text-sm ${mutedClass} break-all`}>
                    <div><span className="font-medium">{t.hostnameLabel}:</span> {serverUrl}</div>
                    {state.server?.ipv4 && (
                      <div><span className="font-medium">{t.ipv4Label}:</span> {state.server.ipv4}</div>
                    )}
                  </div>
                </div>
              )}

              {/* Pairing token */}
              <div className={cardClass}>
                <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                  <div className={titleClass + ' font-semibold text-sm'}>{t.tokenTitle}</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {!showToken ? (
                      <button
                        onClick={handleRevealToken}
                        disabled={!state?.hasPairingToken || busy === 'token'}
                        className={btnClass}
                      >
                        {t.tokenReveal}
                      </button>
                    ) : (
                      <button onClick={() => { setShowToken(false); setToken(null); }} className={btnClass}>
                        {t.tokenHide}
                      </button>
                    )}
                    {showToken && token && (
                      <button onClick={handleCopyToken} className={btnClass}>
                        <Copy size={12} />
                        {justCopied ? t.tokenCopied : t.tokenCopy}
                      </button>
                    )}
                    <button
                      onClick={handleRotateToken}
                      disabled={busy === 'rotate'}
                      className={btnClass}
                    >
                      <RefreshCw size={12} />
                      {t.tokenRotate}
                    </button>
                  </div>
                </div>

                {!state?.hasPairingToken ? (
                  <div className={`text-sm ${mutedClass}`}>{t.tokenMissing}</div>
                ) : (
                  <>
                    {showToken && token ? (
                      <div
                        className={`text-sm font-mono break-all rounded-md border px-2 py-1.5 ${
                          isDarkMode ? 'border-[#54402d] bg-[#1a130d]' : 'border-[#e4dacd] bg-[#faf6ed]'
                        }`}
                      >
                        {token}
                      </div>
                    ) : (
                      <div className={`text-sm font-mono ${mutedClass}`}>••••••••••••••••</div>
                    )}
                    {state.pairingTokenCreatedAt && (
                      <div className={`text-xs mt-2 ${mutedClass}`}>
                        {language === 'zh' ? '生成时间：' : 'Created: '}{formatDate(state.pairingTokenCreatedAt)}
                      </div>
                    )}
                    <div className={`text-xs mt-2 ${mutedClass}`}>{t.tokenRotateHint}</div>
                  </>
                )}
              </div>

              {/* Paired sessions */}
              <div className={cardClass}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <div className={titleClass + ' font-semibold text-sm'}>{t.sessionsTitle}</div>
                    <div className={`text-sm ${mutedClass}`}>
                      {state ? `${state.activeSessionCount} ${t.sessionsCount}` : t.loading}
                    </div>
                  </div>
                  <button
                    onClick={handleRevokeAll}
                    disabled={busy === 'revoke' || !state || state.activeSessionCount === 0}
                    className={dangerBtnClass}
                  >
                    <ShieldOff size={12} />
                    {t.revokeAll}
                  </button>
                </div>
                <div className={`text-xs mt-2 ${mutedClass}`}>{t.revokeHint}</div>
              </div>

              {error && (
                <ErrorCard
                  error={error}
                  language={language}
                  isDarkMode={isDarkMode}
                  onOpenGuide={openGuide}
                />
              )}
            </>
          )}
        </div>
      )}

      <MobileSetupGuideModal
        isOpen={guideOpen}
        onClose={closeGuide}
        language={language}
        isDarkMode={isDarkMode}
        initialSectionId={guideInitialSection}
      />
    </section>
  );
};
