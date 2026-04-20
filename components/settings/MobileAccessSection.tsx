// components/settings/MobileAccessSection.tsx
//
// Desktop-only Settings section for the Phase 1 Mobile Remote Access
// feature. Surfaces the enable toggle, the Tailscale MagicDNS hostname
// (once available), the pairing token (reveal + copy + rotate), and a
// clear message when the Tailscale CLI is missing so the user knows
// how to unblock themselves. See docs/mobile-remote-access.md for
// how all the pieces compose.

import React, { useCallback, useEffect, useState } from 'react';
import { Smartphone, ChevronDown, ChevronUp, Copy, RefreshCw, ShieldOff, ExternalLink } from 'lucide-react';
import { Language } from '../../types';

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

interface MobileAccessSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  language: Language;
}

const COPY = {
  zh: {
    title: '手机远程访问',
    desc: '在手机上通过 Tailscale 私有通道访问桌面版（Phase 1：最小通路）。',
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
    actionError: '操作失败：',
  },
  en: {
    title: 'Mobile Remote Access',
    desc: 'Reach the desktop app from your phone over a private Tailscale tunnel (Phase 1: minimal pipeline).',
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
    actionError: 'Action failed: ',
  },
} as const;

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
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isDesktop) return;
    try {
      const result = await invokeMobileAccess<MobileAccessState>('mobile-access:get-state');
      setState(result);
    } catch (e) {
      setError((e as Error).message);
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
      const result = await invokeMobileAccess<{ ok: boolean; error?: string; state?: MobileAccessState }>(
        'mobile-access:enable',
      );
      if (!result.ok) {
        setError(result.error || 'enable failed');
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
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
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const handleRevealToken = useCallback(async () => {
    setBusy('token');
    setError(null);
    try {
      const result = await invokeMobileAccess<{ ok: boolean; token?: string; error?: string }>(
        'mobile-access:get-pairing-token',
      );
      if (result.ok && result.token) {
        setToken(result.token);
        setShowToken(true);
      } else {
        setError(result.error || 'no token available');
      }
    } catch (e) {
      setError((e as Error).message);
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
      setError('clipboard copy failed');
    }
  }, [token]);

  const handleRotateToken = useCallback(async () => {
    setBusy('rotate');
    setError(null);
    try {
      const result = await invokeMobileAccess<{ ok: boolean; token?: string; error?: string }>(
        'mobile-access:rotate-token',
      );
      if (result.ok && result.token) {
        setToken(result.token);
        setShowToken(true);
      } else {
        setError(result.error || 'rotate failed');
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
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
      setError((e as Error).message);
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
          <p className={`text-sm ${mutedClass}`}>{t.desc}</p>

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
                <div className={`text-sm ${mutedClass}`}>{tailscaleStatusMessage}</div>
                {tailscale?.code === 'E_NO_CLI' && (
                  <a
                    href="https://tailscale.com/download"
                    target="_blank"
                    rel="noreferrer"
                    className={btnClass + ' mt-2'}
                  >
                    <ExternalLink size={12} />
                    {t.installGuide}
                  </a>
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
                <div
                  className={`text-sm rounded-[0.7rem] px-3 py-2 ${
                    isDarkMode ? 'bg-red-900/25 border border-red-700/60 text-red-200' : 'bg-red-50 border border-red-300 text-red-700'
                  }`}
                >
                  {t.actionError}{error}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
};
