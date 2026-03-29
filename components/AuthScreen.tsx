
import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Fingerprint, Lock, ChevronRight, HardDrive, Download, Cloud, RefreshCw, Check, AlertTriangle, FileJson, Link as LinkIcon, UserCircle, Rocket, Database, CheckCircle, RotateCcw } from 'lucide-react';
import { Language, BackupConfig } from '../types';
import { UI_TRANSLATIONS } from '../constants';
import { CLOUD_SYNC_AVAILABLE } from '../services/appConfig';

interface AuthScreenProps {
  onEnterApp: () => void;
  language: Language;
  
  // Data Setup Props
  backupConfig: BackupConfig;
  onBackupConfigChange: (config: BackupConfig) => void;
  onSelectLocalFile: () => Promise<boolean>;
  onImportBackup: (file: File) => Promise<boolean>;
  onDisconnectLocalFile?: () => void;
  
  // Cloud Connection
  onConnectCloud: (url: string, id: string, key?: string) => Promise<boolean>;
  onRestoreCloud: () => Promise<boolean>;
  
  // States
  connectedFileName: string | null;
}

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

export const AuthScreen: React.FC<AuthScreenProps> = ({ 
  onEnterApp, language, backupConfig, onBackupConfigChange, onSelectLocalFile, onImportBackup, onConnectCloud, onRestoreCloud, connectedFileName, onDisconnectLocalFile
}) => {
  const t = UI_TRANSLATIONS[language];
  const [step, setStep] = useState<'LOGIN' | 'SETUP'>('LOGIN');
  
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState(false);
  const [resetState, setResetState] = useState<'IDLE' | 'CONFIRMING' | 'SUCCESS'>('IDLE');
  
  const [setupTab, setSetupTab] = useState<'LOCAL' | 'MANUAL' | 'CLOUD'>('LOCAL');
  const [setupStatus, setSetupStatus] = useState<string>(''); 
  const [setupError, setSetupError] = useState<string | null>(null);
  const [isReadyToEnter, setIsReadyToEnter] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showFirstTimeWarning, setShowFirstTimeWarning] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [isCloudConnected, setIsCloudConnected] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const KITAUJI_BROWN = "#785A42";
  const BG_COLOR = "#f9f7f2"; 
  const DEFAULT_USER = 'Kumiko';
  const DEFAULT_PASS = '0821';

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
    const cloudReady = setupTab === 'CLOUD' && isCloudConnected;

    if (localReady || manualReady || cloudReady) {
      setIsReadyToEnter(true);
    } else {
      setIsReadyToEnter(false);
    }
  }, [step, setupTab, connectedFileName, setupStatus, isCloudConnected, t.statusSuccess]);

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

  const handleTabChange = (tab: 'LOCAL' | 'MANUAL' | 'CLOUD') => {
    setSetupTab(tab);
    setSetupStatus('');
    setSetupError(null);
    setIsReadyToEnter(false);
    setIsCloudConnected(false);
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

  const PortalModal = ({ children, onClose }: { children: React.ReactNode, onClose: () => void }) => {
      useEffect(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); }, []);
      useEffect(() => {
          const preventScroll = (e: TouchEvent) => e.preventDefault();
          document.addEventListener('touchmove', preventScroll, { passive: false });
          return () => {
              document.removeEventListener('touchmove', preventScroll);
          };
      }, []);
      return createPortal(
          <div className="fixed inset-0 z-[99999] flex items-center justify-center touch-none safe-area-padding-modal" style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.7) 30%, rgba(0,0,0,0) 100%)' }} onClick={(e) => { e.stopPropagation(); onClose(); }}>
              <div className="relative z-10 w-full max-w-sm px-4 pointer-events-auto" onClick={e => e.stopPropagation()}>{children}</div>
          </div>, document.body
      );
  };

  const FirstTimeWarningModal = () => {
    if (!showFirstTimeWarning) return null;
    return (
      <PortalModal onClose={() => setShowFirstTimeWarning(false)}>
        <div className="w-full bg-[#f9f7f2] border-2 border-[#785A42] shadow-[0_0_50px_rgba(0,0,0,0.5)] p-6 rounded flex flex-col items-center text-center animate-in zoom-in-95 duration-200">
           <div className="p-3 bg-[#9e2a2b]/10 rounded-full mb-4"><AlertTriangle size={32} className="text-[#9e2a2b]" /></div>
           <h3 className="font-serif font-bold text-lg text-[#785A42] mb-3 tracking-widest border-b border-[#785A42]/20 pb-1">{t.warningTitle}</h3>
           <p className="font-mono text-sm opacity-90 mb-6 leading-relaxed text-[#785A42] whitespace-pre-wrap font-bold">{t.firstTimeWarning}</p>
           <div className="flex w-full gap-3 relative z-20">
              <ForceTouchButton onClick={() => setShowFirstTimeWarning(false)} className="flex-1 py-3 border border-[#785A42]/30 text-[#785A42] font-bold text-xs bg-[#f9f7f2] rounded-sm active:bg-[#785A42]/10">{t.cancel}</ForceTouchButton>
              <ForceTouchButton onClick={confirmFirstTimeEnter} className="flex-1 py-3 bg-[#9e2a2b] text-white font-bold text-xs rounded-sm shadow-md flex items-center justify-center gap-2 active:bg-[#b03031]"><span>{t.iUnderstand}</span><ChevronRight size={14} /></ForceTouchButton>
           </div>
        </div>
      </PortalModal>
    );
  };

  const containerAnimation = isExiting ? 'animate-out fade-out zoom-out-95 duration-1000 fill-mode-forwards' : 'animate-in fade-in zoom-in-95 duration-700';

  return (
    <>
      <div className="fixed top-0 left-0 w-full z-[90] bg-[#f9f7f2] text-[#785A42] transition-all ease-in-out" style={{ height: 'var(--app-height)' }}>
        <div className="fixed inset-0 z-0 opacity-10 pointer-events-none" style={{ backgroundImage: `repeating-linear-gradient(45deg, ${KITAUJI_BROWN} 0, ${KITAUJI_BROWN} 1px, transparent 0, transparent 50%)`, backgroundSize: '30px 30px' }}></div>
        <div className="relative z-10 w-full min-h-full h-full overflow-y-auto touch-scroll">
          <div className={`w-full min-h-full flex flex-col items-center justify-center px-6 pt-[calc(env(safe-area-inset-top)+1.5rem)] pb-[calc(env(safe-area-inset-bottom)+1.5rem)] ${containerAnimation}`}>
            <div className="w-[min(92vw,34rem)] flex flex-col items-center">
                <div className="text-center mb-[clamp(1.5rem,3vh,2rem)] mt-10 md:mt-0">
                  <h2 className="text-[clamp(1.8rem,3.6vh,2.35rem)] font-bold tracking-[0.2em] font-serif text-[#785A42]"> {step === 'LOGIN' ? t.authLoginTitle : t.authSetupTitle} </h2>
                  <div className="h-1 w-24 bg-[#c5a059] mx-auto mt-2"></div>
                </div>

                {step === 'LOGIN' && (
                <div className="flex flex-col gap-[clamp(1rem,2vh,1.5rem)] w-full animate-in slide-in-from-bottom-4 duration-500">
                    <div className="group relative">
                        <label className="block text-xs font-bold tracking-widest mb-1 opacity-60 font-mono">{t.username}</label>
                        <div className="flex items-center border-b-2 border-[#785A42]/30 focus-within:border-[#785A42] transition-colors pb-1"><Fingerprint size={20} className="mr-3 opacity-50" /><input type="text" value={username} onChange={(e) => setUsername(e.target.value)} className="bg-transparent outline-none w-full font-mono text-lg placeholder-[#785A42]/30" placeholder="Kumiko" /></div>
                    </div>
                    <div className="group relative">
                        <label className="block text-xs font-bold tracking-widest mb-1 opacity-60 font-mono">{t.password}</label>
                        <div className="flex items-center border-b-2 border-[#785A42]/30 focus-within:border-[#785A42] transition-colors pb-1"><Lock size={20} className="mr-3 opacity-50" /><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleLogin()} className="bg-transparent outline-none w-full font-mono text-lg placeholder-[#785A42]/30" placeholder="••••" /></div>
                    </div>
                    <div className="flex justify-between items-start text-xs font-mono min-h-[20px]">
                        <span className="opacity-50 mt-1">{t.defaultHint}</span>
                        <div className="flex flex-col items-end">
                            <button type="button" onClick={handleForgotPass} className={`font-bold transition-all duration-200 ${resetState === 'CONFIRMING' ? 'bg-red-600 text-white px-2 py-1 rounded shadow-sm animate-pulse' : 'text-[#9e2a2b] hover:underline py-1'}`}> {resetState === 'CONFIRMING' ? (language === 'zh' ? '确认重置密码?' : 'Confirm Reset?') : t.forgotPass} </button>
                            {resetState === 'SUCCESS' && (<span className="text-green-600 font-bold text-[10px] mt-1 animate-in fade-in slide-in-from-top-1">{language === 'zh' ? '重置成功' : 'Reset Complete'}</span>)}
                        </div>
                    </div>
                    {loginError && ( <div className="text-[#9e2a2b] text-xs font-bold text-center animate-pulse"> ⚠ ACCESS DENIED: INVALID CREDENTIALS </div> )}
                    <ForceTouchButton onClick={handleLogin} className="mt-4 w-full py-3 bg-[#785A42] text-[#f9f7f2] font-bold tracking-[0.1em] flex items-center justify-center gap-2 hover:bg-[#8c6045] active:bg-[#6b503b] transition-all shadow-lg" > <span>{t.loginNext}</span> <ChevronRight size={16} /> </ForceTouchButton>
                </div>
                )}

                {step === 'SETUP' && (
                <div className="flex flex-col gap-[clamp(0.875rem,1.8vh,1.25rem)] w-full animate-in slide-in-from-right-4 duration-500 pb-10">
                    <p className="text-xs text-center opacity-60 font-mono mb-2">{t.setupDesc}</p>
                    <div className="flex border border-[#785A42]/20 rounded overflow-hidden">
                        <ForceTouchButton onClick={() => handleTabChange('LOCAL')} className={`flex-1 py-2 text-[10px] font-bold tracking-tighter flex flex-col items-center gap-1 transition-colors ${setupTab === 'LOCAL' ? 'bg-[#785A42] text-white' : 'bg-white hover:bg-[#785A42]/10'}`} > <HardDrive size={14} /> {t.tabLocal} </ForceTouchButton>
                        <div className="w-px bg-[#785A42]/20"></div>
                        <ForceTouchButton onClick={() => handleTabChange('MANUAL')} className={`flex-1 py-2 text-[10px] font-bold tracking-tighter flex flex-col items-center gap-1 transition-colors ${setupTab === 'MANUAL' ? 'bg-[#785A42] text-white' : 'bg-white hover:bg-[#785A42]/10'}`} > <Download size={14} /> {t.tabManual} </ForceTouchButton>
                        {CLOUD_SYNC_AVAILABLE && (
                          <>
                            <div className="w-px bg-[#785A42]/20"></div>
                            <ForceTouchButton onClick={() => handleTabChange('CLOUD')} className={`flex-1 py-2 text-[10px] font-bold tracking-tighter flex flex-col items-center gap-1 transition-colors ${setupTab === 'CLOUD' ? 'bg-[#785A42] text-white' : 'bg-white hover:bg-[#785A42]/10'}`} > <Cloud size={14} /> {t.tabCloud} </ForceTouchButton>
                          </>
                        )}
                    </div>

                    <div className="min-h-[clamp(180px,24vh,250px)] bg-white/50 border border-[#785A42]/20 rounded p-4 flex flex-col justify-center">
                        {setupTab === 'LOCAL' && (
                        <div className="flex flex-col gap-3 items-center text-center">
                            <p className="text-[10px] opacity-60 leading-tight">{t.authLocalDesc}</p>
                            {connectedFileName ? (
                                <div className="flex flex-col gap-2 w-full">
                                  <div className="flex items-center justify-center gap-2 text-green-700 font-mono text-xs font-bold bg-green-50 px-3 py-2 rounded border border-green-200"> 
                                    <Check size={14} /> {t.savingTo} {connectedFileName} 
                                  </div>
                                  {onDisconnectLocalFile && (
                                    <button 
                                      onClick={onDisconnectLocalFile}
                                      className="w-full py-1.5 rounded border border-red-300 bg-red-50 hover:bg-red-100 text-red-600 text-[11px] font-bold flex items-center justify-center gap-1.5 transition-colors"
                                    >
                                      <RotateCcw size={12} /> {language === 'zh' ? '断开连接' : 'Disconnect'}
                                    </button>
                                  )}
                                </div>
                            ) : (
                                <ForceTouchButton onClick={handleLocalMount} disabled={isProcessing} className="w-full py-2 border-2 border-dashed border-[#785A42]/40 text-[#785A42] font-bold text-xs hover:bg-[#785A42]/5 transition-colors flex items-center justify-center gap-2" > {isProcessing ? <RefreshCw className="animate-spin" size={14} /> : <HardDrive size={14} />} {t.btnSelectFile} </ForceTouchButton>
                            )}
                        </div>
                        )}

                        {setupTab === 'MANUAL' && (
                        <div className="flex flex-col gap-3 items-center text-center">
                            <input type="file" ref={fileInputRef} className="hidden" accept=".json,.zip" onChange={handleManualImport} />
                            {setupError && (setupError.includes('成功') || setupError.includes('Successful')) ? (
                                <div className="w-full py-4 border-2 border-dashed border-green-500/40 text-green-600 font-bold text-xs bg-green-50/50 rounded flex flex-col items-center justify-center gap-2">
                                    <Check size={20} />
                                    <span>{t.importSuccess}</span>
                                </div>
                            ) : (
                                <ForceTouchButton onClick={() => fileInputRef.current?.click()} disabled={isProcessing} className="w-full py-4 border-2 border-dashed border-[#785A42]/40 text-[#785A42] font-bold text-xs hover:bg-[#785A42]/5 transition-colors flex flex-col items-center justify-center gap-2" > 
                                    {isProcessing ? <RefreshCw className="animate-spin" size={20} /> : <FileJson size={20} />} 
                                    <span>{t.btnImport}</span>
                                    <span className="text-[10px] font-normal opacity-70">{language === 'zh' ? '支持 .json / .zip 格式' : 'Supports .json / .zip formats'}</span>
                                </ForceTouchButton>
                            )}
                        </div>
                        )}

                        {setupError && !setupError.includes('成功') && !setupError.includes('Successful') && ( <div className="mt-3 text-center text-xs font-bold text-red-600 animate-in fade-in flex items-center justify-center gap-1"> <AlertTriangle size={12} /> {setupError} </div> )}
                    </div>

                    <div className="flex items-center justify-center gap-1.5 mt-2 opacity-70"> <Database size={12} className="text-[#785A42]" /> <p className="text-[10px] font-mono font-bold text-[#785A42]">{t.ragHint}</p> </div>

                    <div className="flex flex-col gap-2 mt-2">
                        <ForceTouchButton onClick={handleExitTransition} disabled={!isReadyToEnter} className={`w-full py-3 font-bold tracking-[0.1em] flex items-center justify-center gap-2 transition-all shadow-lg ${isReadyToEnter ? 'bg-[#9e2a2b] text-white hover:bg-[#b03031] cursor-pointer' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`} > <Rocket size={16} /> {t.btnEnterSystem} </ForceTouchButton>
                        {!isReadyToEnter && ( <ForceTouchButton onClick={handleFirstTimeClick} className="text-xs font-mono text-[#785A42]/60 hover:text-[#785A42] hover:underline text-center py-2" > {t.btnFirstTime} </ForceTouchButton> )}
                    </div>
                </div>
                )}
                
                <div className="mt-auto pt-6 text-[9px] font-mono opacity-30 text-[#785A42]"> {t.securityLayer} </div>
            </div>
          </div>
        </div>
      </div>

      <FirstTimeWarningModal />
    </>
  );
};
