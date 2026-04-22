
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Fingerprint, Lock, ChevronRight, HardDrive, Download, RefreshCw, Check, AlertTriangle, FileJson, Link as LinkIcon, UserCircle, Rocket, Database, CheckCircle, RotateCcw, Monitor } from 'lucide-react';
import { Language, BackupConfig } from '../types';
import { UI_TRANSLATIONS } from '../constants';
import { isMobilePwa } from '../services/environment';

// Cloud sync removed from the product — any references to CLOUD_SYNC_AVAILABLE have been
// deleted along with the CLOUD tab. If the feature returns, reintroduce the constant
// and the conditional Tab rendering from git history.

interface AuthScreenProps {
  onEnterApp: () => void;
  language: Language;
  
  // Data Setup Props
  backupConfig: BackupConfig;
  onBackupConfigChange: (config: BackupConfig) => void;
  onSelectLocalFile: () => Promise<boolean>;
  onImportBackup: (file: File) => Promise<boolean>;
  onDisconnectLocalFile?: () => void;

  // onConnectCloud / onRestoreCloud removed with cloud sync (P0 #6).

  // States
  connectedFileName: string | null;
}

// --- PORTAL MODAL (module-level so React does not unmount/remount on every parent render) ---
// Defined at module scope rather than inside AuthScreen because a component defined inside
// another component creates a *new component type* on every parent render, which makes React
// treat it as a different component and tear down its state + effects every time. That caused
// the first-time warning modal to flicker / double-blur, and similar modals in MemoryPanel to
// lose scroll position when the parent re-rendered.
const PortalModal: React.FC<{ children: React.ReactNode; onClose: () => void }> = ({ children, onClose }) => {
    useEffect(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }, []);
    useEffect(() => {
        const preventScroll = (e: TouchEvent) => e.preventDefault();
        document.addEventListener('touchmove', preventScroll, { passive: false });
        return () => {
            document.removeEventListener('touchmove', preventScroll);
        };
    }, []);
    return createPortal(
        <div
            className="fixed inset-0 z-[99999] flex items-center justify-center touch-none safe-area-padding-modal"
            style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.7) 30%, rgba(0,0,0,0) 100%)' }}
            onClick={(e) => { e.stopPropagation(); onClose(); }}
        >
            <div className="relative z-10 w-full max-w-sm px-4 pointer-events-auto" onClick={e => e.stopPropagation()}>
                {children}
            </div>
        </div>,
        document.body
    );
};

// --- FORCE TOUCH BUTTON (THE ULTIMATE IOS FIX) ---
const ForceTouchButton = ({ onClick, className, children, style, disabled, type = "button" }: any) => {
  const btnRef = useRef<HTMLButtonElement>(null);
  const startPos = useRef({ x: 0, y: 0 });
  const isPressed = useRef(false);
  const callbackRef = useRef(onClick);

  useEffect(() => { callbackRef.current = onClick; }, [onClick]);

  useEffect(() => {
    const element = btnRef.current;
    if (!element || disabled) return;

    const handleTouchStart = (e: TouchEvent) => {
      isPressed.current = true;
      startPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!isPressed.current) return;
      isPressed.current = false;
      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      if (Math.abs(endX - startPos.current.x) < 20 && Math.abs(endY - startPos.current.y) < 20) {
        e.preventDefault();
        e.stopPropagation();
        if (navigator.vibrate) navigator.vibrate(5);
        if (callbackRef.current) callbackRef.current(e);
      }
    };

    const handleCancel = () => { isPressed.current = false; };
    const handleClick = (e: MouseEvent) => { if (e.detail === 0) return; if (callbackRef.current) callbackRef.current(e); };

    element.addEventListener('touchstart', handleTouchStart, { passive: false });
    element.addEventListener('touchend', handleTouchEnd, { passive: false });
    element.addEventListener('touchcancel', handleCancel);
    element.addEventListener('click', handleClick);

    return () => {
        element.removeEventListener('touchstart', handleTouchStart);
        element.removeEventListener('touchend', handleTouchEnd);
        element.removeEventListener('touchcancel', handleCancel);
        element.removeEventListener('click', handleClick);
    };
  }, [disabled]);

  return (
    <button ref={btnRef} type={type} disabled={disabled} className={`${className} cursor-pointer select-none`} style={{ ...style, WebkitTapHighlightColor: 'transparent', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none' }}>
      {children}
    </button>
  );
};

// --- FIRST-TIME WARNING (module-level; see PortalModal note above) ---
// Previously defined inline in AuthScreen, which caused the modal to unmount & remount
// on every parent render, triggering repeated focus blur / animation replays.
interface FirstTimeWarningModalProps {
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  t: typeof UI_TRANSLATIONS[keyof typeof UI_TRANSLATIONS];
}
const FirstTimeWarningModal: React.FC<FirstTimeWarningModalProps> = ({ isOpen, onCancel, onConfirm, t }) => {
  if (!isOpen) return null;
  return (
    <PortalModal onClose={onCancel}>
      <div className="w-full bg-[#f9f7f2] border border-[#785A42]/20 shadow-[0_8px_32px_rgba(0,0,0,0.3)] p-6 rounded-lg flex flex-col items-center text-center animate-in zoom-in-95 duration-200">
         <div className="p-3 bg-[#9e2a2b]/10 rounded-full mb-4"><AlertTriangle size={32} className="text-[#9e2a2b]" /></div>
         <h3 className="font-mincho ka-overlay-title text-[#785A42] mb-3 tracking-[0.04em] border-b border-[#785A42]/20 pb-1">{t.warningTitle}</h3>
         <p className="ka-copy-sm opacity-90 mb-6 leading-relaxed text-[#785A42] whitespace-pre-wrap">{t.firstTimeWarning}</p>
         <div className="flex w-full gap-3 relative z-20">
            <ForceTouchButton onClick={onCancel} className="flex-1 py-3 min-h-[44px] border border-[#785A42]/20 text-[#785A42] ka-label bg-[#f9f7f2] rounded-lg active:bg-[#785A42]/10">{t.cancel}</ForceTouchButton>
            <ForceTouchButton onClick={onConfirm} className="flex-1 py-3 min-h-[44px] bg-[#9e2a2b] text-white ka-label rounded-lg shadow-md flex items-center justify-center gap-2 active:bg-[#b03031]"><span>{t.iUnderstand}</span><ChevronRight size={14} /></ForceTouchButton>
         </div>
      </div>
    </PortalModal>
  );
};

export const AuthScreen: React.FC<AuthScreenProps> = ({ 
  onEnterApp, language, backupConfig, onBackupConfigChange, onSelectLocalFile, onImportBackup, connectedFileName, onDisconnectLocalFile
}) => {
  const t = UI_TRANSLATIONS[language];
  const [step, setStep] = useState<'LOGIN' | 'SETUP'>('LOGIN');
  
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState(false);
  const [resetState, setResetState] = useState<'IDLE' | 'CONFIRMING' | 'SUCCESS'>('IDLE');

  // Only LOCAL and MANUAL tabs remain; the CLOUD tab (and its isCloudConnected state)
  // were removed along with the cloud sync feature (P0 #6).
  const [setupTab, setSetupTab] = useState<'LOCAL' | 'MANUAL'>('LOCAL');
  const [setupStatus, setSetupStatus] = useState<string>('');
  const [setupError, setSetupError] = useState<string | null>(null);
  const [isReadyToEnter, setIsReadyToEnter] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showFirstTimeWarning, setShowFirstTimeWarning] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const BG_COLOR = "#f9f7f2"; 
  const DEFAULT_USER = 'Kumiko';
  const DEFAULT_PASS = '0821';

  // --- INLINE STYLES ---
  const styles = `
    .font-elegant { font-family: var(--font-elegant); }
    .font-mincho { font-family: var(--font-display); }

    .auth-bg-login {
      background-color: ${BG_COLOR};
      background-image: 
        repeating-linear-gradient(0deg, transparent, transparent 39px, rgba(120,90,66,0.035) 39px, rgba(120,90,66,0.035) 40px);
    }
    .auth-bg-setup {
      background-color: ${BG_COLOR};
      background-image: 
        repeating-linear-gradient(0deg, transparent, transparent 39px, rgba(120,90,66,0.03) 39px, rgba(120,90,66,0.03) 40px),
        url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.025'/%3E%3C/svg%3E");
    }

    /* === RESPONSIVE TEXT SCALE (vw-based) === */
    .auth-title { font-size: clamp(24px, 3.3vw, 38px); }
    .auth-subtitle { font-size: clamp(11px, 1vw, 13px); }
    .auth-label { font-size: clamp(12px, 1.15vw, 14px); }
    .auth-input-text { font-size: clamp(16px, 1.35vw, 19px); }
    .auth-btn-text { font-size: clamp(15px, 1.18vw, 18px); }
    .auth-hint { font-size: clamp(11px, 1.02vw, 13px); }
    .auth-tab-text { font-size: clamp(11px, 0.98vw, 12px); }

    /* Title accent */
    .auth-title-accent {
      position: relative; display: inline-block;
    }
    .auth-title-accent::after {
      content: ''; position: absolute; bottom: -6px; left: 15%; width: 70%; height: 2px;
      background: linear-gradient(90deg, transparent, #c5a059, transparent);
      border-radius: 1px;
    }

    @keyframes scan-line {
      0%, 100% { width: 0; opacity: 0; }
      50% { width: 100%; opacity: 1; }
    }
    .scan-underline {
      position: relative;
    }
    .scan-underline::after {
      content: '';
      position: absolute;
      bottom: -8px;
      left: 50%;
      transform: translateX(-50%);
      height: 2px;
      background: linear-gradient(90deg, transparent, #c5a059, transparent);
      animation: scan-line 4s ease-in-out infinite;
    }

    @keyframes fingerprint-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(120,90,66,0.15); }
      50% { box-shadow: 0 0 0 10px rgba(120,90,66,0); }
    }
    .fingerprint-glow {
      animation: fingerprint-pulse 3s ease-in-out infinite;
    }

    .glass-input {
      background: rgba(255,255,255,0.5);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      border: 1px solid rgba(120,90,66,0.12);
      border-radius: clamp(8px, 1.2vw, 14px);
      transition: all 0.3s ease;
    }
    .glass-input:focus-within {
      border-color: rgba(120,90,66,0.3);
      box-shadow: 0 2px 16px rgba(120,90,66,0.08);
    }

    .btn-primary-auth {
      position: relative;
      overflow: hidden;
      transition: all 0.3s ease;
    }
    .btn-primary-auth::before {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);
      transition: left 0.6s ease;
    }
    .btn-primary-auth:hover::before {
      left: 100%;
    }
    .btn-primary-auth:hover {
      transform: translateY(-1px);
      box-shadow: 0 8px 24px rgba(120,90,66,0.25);
    }
    .btn-primary-auth:active {
      transform: translateY(0);
    }

    .pill-tabs {
      background: rgba(255,255,255,0.4);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      border: 1px solid rgba(120,90,66,0.1);
      border-radius: clamp(10px, 1.4vw, 14px);
      padding: clamp(3px, 0.4vw, 5px);
    }
    .pill-tab {
      border-radius: clamp(8px, 1.2vw, 12px);
      transition: all 0.25s ease;
    }
    .pill-tab-active {
      background: #785A42;
      color: #f9f7f2;
      box-shadow: 0 2px 10px rgba(120,90,66,0.22);
    }

    .file-drop-zone {
      background: rgba(255,253,245,0.6);
      border: 1.5px dashed rgba(120,90,66,0.28);
      border-radius: clamp(10px, 1.4vw, 16px);
      transition: all 0.3s ease;
    }
    .file-drop-zone:hover {
      border-color: rgba(120,90,66,0.45);
      background: rgba(255,253,245,0.85);
      box-shadow: inset 0 0 24px rgba(197,160,89,0.06);
    }
  `;

  useEffect(() => {
      const handleResume = (event: PageTransitionEvent) => {
          if (event.persisted) window.location.reload();
      };
      window.addEventListener('pageshow', handleResume);
      return () => window.removeEventListener('pageshow', handleResume);
  }, []);

  useEffect(() => {
    document.body.style.backgroundColor = BG_COLOR;
    document.documentElement.style.backgroundColor = BG_COLOR;
    let metaThemeColor = document.querySelector("meta[name='theme-color']");
    if (!metaThemeColor) {
      metaThemeColor = document.createElement('meta');
      metaThemeColor.setAttribute('name', 'theme-color');
      document.head.appendChild(metaThemeColor);
    }
    metaThemeColor.setAttribute('content', BG_COLOR);
  }, []);

  useEffect(() => {
    const storedUser = localStorage.getItem('kumiko_auth_username') || DEFAULT_USER;
    setUsername(storedUser);
  }, []);

  useEffect(() => {
    if (step !== 'SETUP') return;

    const localReady = setupTab === 'LOCAL' && !!connectedFileName;
    const manualReady = setupTab === 'MANUAL' && setupStatus === t.statusSuccess;

    if (localReady || manualReady) {
      setIsReadyToEnter(true);
    } else {
      setIsReadyToEnter(false);
    }
  }, [step, setupTab, connectedFileName, setupStatus, t.statusSuccess]);

  const handleLogin = () => {
    const storedUser = localStorage.getItem('kumiko_auth_username') || DEFAULT_USER;
    const storedPass = localStorage.getItem('kumiko_auth_password') || DEFAULT_PASS;
    if (username === storedUser && password === storedPass) {
      setStep('SETUP');
      setLoginError(false);
    } else {
      setLoginError(true);
      setTimeout(() => setLoginError(false), 500);
    }
  };

  const handleForgotPass = () => {
    if (resetState === 'IDLE') {
        setResetState('CONFIRMING');
        setTimeout(() => setResetState(prev => prev === 'CONFIRMING' ? 'IDLE' : prev), 3000);
    } else if (resetState === 'CONFIRMING') confirmReset();
  };

  const confirmReset = () => {
    localStorage.setItem('kumiko_auth_username', DEFAULT_USER);
    localStorage.setItem('kumiko_auth_password', DEFAULT_PASS);
    setUsername(DEFAULT_USER);
    setPassword(DEFAULT_PASS);
    setLoginError(false);
    setResetState('SUCCESS');
    setTimeout(() => setResetState('IDLE'), 3000);
  };

  const handleTabChange = (tab: 'LOCAL' | 'MANUAL') => {
    setSetupTab(tab);
    setSetupStatus('');
    setSetupError(null);
    setIsReadyToEnter(false);
  };

  const handleLocalMount = async () => {
    setIsProcessing(true);
    setSetupError(null);
    const success = await onSelectLocalFile();
    setIsProcessing(false);
    if (success) {
      setSetupStatus(t.statusSuccess);
      setIsReadyToEnter(true);
    }
  };

  const handleManualImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsProcessing(true);
    setSetupError(null);
    const success = await onImportBackup(file);
    setIsProcessing(false);
    if (success) {
      setSetupStatus(t.statusSuccess);
      setSetupError(language === 'zh' ? '导入成功！' : 'Import Successful!');
      setTimeout(() => {
        setIsReadyToEnter(true);
      }, 1000);
    }
    e.target.value = '';
  };

  const handleExitTransition = () => {
    setIsExiting(true);
    setTimeout(() => { onEnterApp(); }, 800); 
  };

  const handleFirstTimeClick = () => { setShowFirstTimeWarning(true); };

  const confirmFirstTimeEnter = () => {
    setShowFirstTimeWarning(false);
    setIsReadyToEnter(true);
    handleExitTransition();
  };

  // PortalModal and FirstTimeWarningModal are defined at module scope above — this
  // avoids React treating them as fresh component types every render (which would
  // remount the modal subtree and replay focus/animations). See the long comment
  // next to the `PortalModal` definition.

  const containerAnimation = isExiting ? 'animate-out fade-out zoom-out-95 duration-1000 fill-mode-forwards' : 'animate-in fade-in zoom-in-95 duration-700';
  const bgClass = step === 'LOGIN' ? 'auth-bg-login' : 'auth-bg-setup';

  return (
    <>
      <style>{styles}</style>
      <div className={`fixed top-0 left-0 w-full z-[90] ${bgClass} text-[#785A42] transition-all ease-in-out`} style={{ height: 'var(--app-height)' }}>
        <div className="relative z-10 w-full min-h-full h-full overflow-y-auto touch-scroll">
          <div className={`w-full min-h-full h-full flex flex-col items-center justify-center px-[clamp(20px,4vw,48px)] pt-[calc(var(--sat)+1rem)] pb-[calc(var(--sab)+0.5rem)] ${containerAnimation}`}>
            <div className="w-[min(92vw,42rem)] flex flex-col items-center">
                {/* HEADER */}
                <div className={`text-center ${step === 'SETUP' ? 'mb-[clamp(10px,1.5vw,18px)] mt-[clamp(10px,2vw,20px)]' : 'mb-[clamp(18px,3vw,30px)] mt-[clamp(12px,2vw,24px)]'}`}>
                  <h2 className="auth-title font-semibold tracking-[0.025em] font-mincho text-[#785A42] auth-title-accent inline-block leading-[1.08]">
                    {step === 'LOGIN' ? t.authLoginTitle : t.authSetupTitle}
                  </h2>
                  {step === 'LOGIN' && (
                    <p className="auth-subtitle font-elegant tracking-[0.18em] text-[#785A42]/55 mt-[clamp(10px,1.5vw,16px)] uppercase">
                      AMADEUS SECURITY LAYER
                    </p>
                  )}
                  {step === 'SETUP' && (
                    <p className="auth-hint ka-copy-sm tracking-[0.05em] text-[#785A42]/60 mt-[clamp(8px,1.4vw,14px)]">
                      {t.setupDesc}
                    </p>
                  )}
                </div>

                {/* ============ LOGIN STEP ============ */}
                {step === 'LOGIN' && (
                <div className="flex flex-col gap-[clamp(14px,2.2vw,22px)] w-full animate-in slide-in-from-bottom-4 duration-500">
                    <div className="glass-input px-[clamp(14px,2vw,22px)] py-[clamp(12px,1.8vw,18px)]">
                        <label className="block auth-label ka-copy-sm font-semibold tracking-[0.04em] mb-[clamp(4px,0.6vw,8px)] text-[#785A42]/65">{t.username}</label>
                        <div className="flex items-center gap-[clamp(8px,1.2vw,14px)]">
                          <div className="p-[clamp(6px,0.8vw,10px)] rounded-full bg-[#785A42]/8 fingerprint-glow">
                            <Fingerprint size={20} className="text-[#785A42]/50" />
                          </div>
                          <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} className="bg-transparent outline-none w-full ka-input-copy auth-input-text placeholder-[#785A42]/30" placeholder="Kumiko" />
                        </div>
                    </div>

                    <div className="glass-input px-[clamp(14px,2vw,22px)] py-[clamp(12px,1.8vw,18px)]">
                        <label className="block auth-label ka-copy-sm font-semibold tracking-[0.04em] mb-[clamp(4px,0.6vw,8px)] text-[#785A42]/65">{t.password}</label>
                        <div className="flex items-center gap-[clamp(8px,1.2vw,14px)]">
                          <div className="p-[clamp(6px,0.8vw,10px)] rounded-full bg-[#785A42]/8">
                            <Lock size={20} className="text-[#785A42]/50" />
                          </div>
                          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleLogin()} className="bg-transparent outline-none w-full ka-input-copy auth-input-text placeholder-[#785A42]/30" placeholder="••••" />
                        </div>
                    </div>

                    <div className="flex justify-between items-start auth-hint min-h-[20px]">
                        <span className="ka-copy-sm text-[#785A42]/55 mt-1">{t.defaultHint}</span>
                        <div className="flex flex-col items-end">
                            <button type="button" onClick={handleForgotPass} className={`ka-label transition-all duration-200 ${resetState === 'CONFIRMING' ? 'bg-red-600 text-white px-2 py-1 rounded-md shadow-sm animate-pulse' : 'text-[#9e2a2b] hover:underline py-1'}`}> {resetState === 'CONFIRMING' ? (language === 'zh' ? '确认重置密码?' : 'Confirm Reset?') : t.forgotPass} </button>
                            {resetState === 'SUCCESS' && (<span className="text-green-600 ka-copy-sm mt-1 animate-in fade-in slide-in-from-top-1">{language === 'zh' ? '重置成功' : 'Reset Complete'}</span>)}
                        </div>
                    </div>
                    {loginError && ( <div className="text-[#9e2a2b] auth-hint ka-copy-sm text-center animate-pulse"> ⚠ ACCESS DENIED: INVALID CREDENTIALS </div> )}
                    
                    <ForceTouchButton onClick={handleLogin} className="mt-[clamp(6px,1vw,14px)] w-full py-[clamp(10px,1.8vw,16px)] min-h-[48px] bg-[#785A42] text-[#f9f7f2] ka-label auth-btn-text font-semibold flex items-center justify-center gap-2 rounded-xl btn-primary-auth shadow-[0_4px_16px_rgba(120,90,66,0.2)]" >
                      <span>{t.loginNext}</span> <ChevronRight size={16} />
                    </ForceTouchButton>
                </div>
                )}

                {/* ============ SETUP STEP ============ */}
                {step === 'SETUP' && (
                <div className="flex flex-col gap-[clamp(10px,1.5vw,18px)] w-full animate-in fade-in duration-300">
                    {/* PILL TABS */}
                    <div className="pill-tabs flex">
                        <ForceTouchButton onClick={() => handleTabChange('LOCAL')} className={`pill-tab flex-1 min-w-0 py-[clamp(8px,1.4vw,14px)] min-h-[44px] text-[clamp(0.6rem,1.2vw,0.75rem)] font-bold tracking-tight flex flex-col items-center justify-center gap-1 whitespace-nowrap overflow-hidden ${setupTab === 'LOCAL' ? 'pill-tab-active' : 'text-[#785A42]/70 hover:bg-white/30'}`} >
                          <HardDrive size={16} /> {t.tabLocal}
                        </ForceTouchButton>
                        <ForceTouchButton onClick={() => handleTabChange('MANUAL')} className={`pill-tab flex-1 min-w-0 py-[clamp(8px,1.4vw,14px)] min-h-[44px] text-[clamp(0.6rem,1.2vw,0.75rem)] font-bold tracking-tight flex flex-col items-center justify-center gap-1 whitespace-nowrap overflow-hidden ${setupTab === 'MANUAL' ? 'pill-tab-active' : 'text-[#785A42]/70 hover:bg-white/30'}`} >
                          <Download size={16} /> {t.tabManual}
                        </ForceTouchButton>
                        {/* CLOUD tab removed with cloud sync feature (P0 #6) */}
                    </div>

                    {/* CONTENT AREA */}
                    <div className="h-[clamp(200px,28vh,300px)] glass-input p-[clamp(16px,2.5vw,28px)] flex flex-col justify-between">
                        <div className="flex-1 min-h-0 flex flex-col justify-center">
                        {setupTab === 'LOCAL' && (
                        <div className="w-full h-full flex flex-col gap-[clamp(12px,1.3vw,16px)] items-center justify-center text-center">
                            <p className="auth-hint ka-copy-sm text-[#785A42]/60 leading-relaxed max-w-[28rem] break-words">{t.authLocalDesc}</p>
                            {/* Phase 7 Part t5_onboarding_mobile: on the phone we
                                delegate folder/filename pickers to the PC via
                                MobileRemoteFileBrowser (Phase 6 Part C4).
                                Callers see the same <HardDrive> button on both
                                platforms, but the phone label makes it clear
                                nothing gets written to the handset — the
                                backup lives on the paired desktop. */}
                            {isMobilePwa() && (
                              <div className="flex items-center gap-1.5 text-[11px] text-[#785A42]/55 ka-copy-sm">
                                <Monitor size={12} /> <span className="break-words">{language === 'zh' ? '手机上将弹出远程文件选择器，浏览并写入 PC 上的文件' : 'A remote file picker will let you browse and write to files on the paired PC.'}</span>
                              </div>
                            )}
                            {connectedFileName ? (
                                <div className="flex flex-col gap-3 w-full min-h-[80px] flex-1 justify-center">
                                  <div className="flex items-center justify-center gap-2 text-green-700 ka-copy-sm bg-green-50/80 px-3 py-[clamp(8px,1vw,12px)] rounded-xl border border-green-200/50"> 
                                    <Check size={15} /> <span className="truncate max-w-full">{t.savingTo} {connectedFileName}</span>
                                  </div>
                                  {onDisconnectLocalFile && (
                                    <button 
                                      onClick={onDisconnectLocalFile}
                                      className="w-full py-[clamp(8px,1vw,12px)] rounded-xl border border-red-200/50 bg-red-50/60 hover:bg-red-100/80 text-red-600 ka-copy-sm font-semibold flex items-center justify-center gap-1.5 transition-colors"
                                    >
                                      <RotateCcw size={13} /> {language === 'zh' ? '断开连接' : 'Disconnect'}
                                    </button>
                                  )}
                                </div>
                            ) : (
                                <ForceTouchButton onClick={handleLocalMount} disabled={isProcessing} className="file-drop-zone w-full min-h-[80px] flex-1 py-[clamp(18px,2.5vw,26px)] text-[#785A42] ka-copy-sm font-semibold flex items-center justify-center gap-2" > {isProcessing ? <RefreshCw className="animate-spin" size={16} /> : <HardDrive size={18} />} {t.btnSelectFile} </ForceTouchButton>
                            )}
                        </div>
                        )}

                        {setupTab === 'MANUAL' && (
                        <div className="w-full h-full flex flex-col gap-[clamp(12px,1.3vw,16px)] items-center justify-center text-center">
                            <input type="file" ref={fileInputRef} className="hidden" accept=".json,.zip" onChange={handleManualImport} />
                            {setupError && (setupError.includes('成功') || setupError.includes('Successful')) ? (
                                <div className="w-full min-h-[80px] flex-1 py-[clamp(14px,2.5vw,24px)] border border-green-300/40 text-green-600 ka-copy-sm font-semibold bg-green-50/50 rounded-xl flex flex-col items-center justify-center gap-2">
                                    <Check size={22} />
                                    <span>{t.importSuccess}</span>
                                </div>
                            ) : (
                                <ForceTouchButton onClick={() => fileInputRef.current?.click()} disabled={isProcessing} className="file-drop-zone w-full min-h-[80px] flex-1 py-[clamp(18px,3vw,30px)] text-[#785A42] ka-copy-sm font-semibold flex flex-col items-center justify-center gap-2" > 
                                    {isProcessing ? <RefreshCw className="animate-spin" size={22} /> : <FileJson size={24} />} 
                                    <span>{t.btnImport}</span>
                                    <span className="auth-hint ka-copy-sm font-normal text-[#785A42]/55">{language === 'zh' ? '支持 .json / .zip 格式' : 'Supports .json / .zip formats'}</span>
                                </ForceTouchButton>
                            )}
                        </div>
                        )}
                        </div>

                        <div className="min-h-[28px] mt-3 flex items-center justify-center">
                          {setupError && !setupError.includes('成功') && !setupError.includes('Successful') && ( <div className="text-center auth-hint ka-copy-sm text-red-600 animate-in fade-in flex items-center justify-center gap-1"> <AlertTriangle size={13} /> {setupError} </div> )}
                        </div>
                    </div>

                    <div className="flex items-center justify-center gap-1.5 mt-1"> <Database size={13} className="text-[#785A42]/60" /> <p className="auth-hint ka-copy-sm text-[#785A42]/60">{t.ragHint}</p> </div>

                    <div className="flex flex-col gap-[clamp(6px,1vw,10px)] mt-[clamp(6px,1vw,12px)]">
                        <ForceTouchButton onClick={handleExitTransition} disabled={!isReadyToEnter} className={`w-full py-[clamp(12px,2vw,18px)] min-h-[48px] ka-label auth-btn-text font-semibold flex items-center justify-center gap-2 rounded-xl btn-primary-auth transition-all ${isReadyToEnter ? 'bg-[#9e2a2b] text-white shadow-[0_4px_16px_rgba(158,42,43,0.2)]' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`} > <Rocket size={18} /> {t.btnEnterSystem} </ForceTouchButton>
                        {!isReadyToEnter && ( <ForceTouchButton onClick={handleFirstTimeClick} className="auth-hint ka-copy-sm text-[#785A42]/50 hover:text-[#785A42] hover:underline text-center py-2 transition-colors" > {t.btnFirstTime} </ForceTouchButton> )}
                    </div>
                </div>
                )}
                
                <div className="mt-[clamp(6px,1vw,12px)] auth-hint ka-kicker text-[#785A42]/25 tracking-[0.2em]"> {t.securityLayer} </div>
            </div>
          </div>
        </div>
      </div>

      <FirstTimeWarningModal
        isOpen={showFirstTimeWarning}
        onCancel={() => setShowFirstTimeWarning(false)}
        onConfirm={confirmFirstTimeEnter}
        t={t}
      />
    </>
  );
};
