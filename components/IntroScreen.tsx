
import React, { useEffect, useState, useMemo } from 'react';
import { AlertTriangle, Fingerprint, Music, Wind, Globe, Maximize, Minimize } from 'lucide-react';
import { Language } from '../types';
import { UI_TRANSLATIONS } from '../constants';

interface IntroScreenProps {
  onConnect: () => void;
  language: Language;
  onLanguageChange: (lang: Language) => void;
}

export const IntroScreen: React.FC<IntroScreenProps> = ({ onConnect, language, onLanguageChange }) => {
  const t = UI_TRANSLATIONS[language];
  const [bootLog, setBootLog] = useState<string[]>([]);
  const [showContent, setShowContent] = useState(false);
  const [isFadingOut, setIsFadingOut] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  
  // --- MEMOIZED PARTICLE DATA (FIX FOR METEOR BUG) ---
  const particles = useMemo(() => {
      const count = window.innerWidth < 768 ? 4 : 12; 
      return [...Array(count)].map((_, i) => ({
          id: i,
          left: `${Math.random() * 100}%`,
          animationDuration: `${10 + Math.random() * 15}s`,
          animationDelay: `${Math.random() * 8}s`,
          opacity: 0.4 + Math.random() * 0.4,
          size: i % 3 === 0 ? '14px' : (i % 2 === 0 ? '8px' : '12px'),
          background: i % 3 === 0 ? '#ffc0cb' : 'linear-gradient(135deg, #ffdde1 0%, #ee9ca7 100%)'
      }));
  }, []);

  // --- KITAUJI COLOR PALETTE ---
  const BG_COLOR = "#f9f7f2"; 
  const KITAUJI_BROWN = "#785A42"; 

  // --- iOS BACKGROUND SYNC EFFECT ---
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

  const styles = `
    .font-elegant { font-family: var(--font-elegant); }
    .font-mincho { font-family: var(--font-display); }

    /* Background: Subtle Sheet Music Lines */
    .sheet-music-bg {
      background-color: ${BG_COLOR};
      background-image: repeating-linear-gradient(
        transparent,
        transparent 20px,
        rgba(120, 90, 66, 0.03) 20px,
        rgba(120, 90, 66, 0.03) 21px
      );
      position: relative;
    }
    
    @media (min-width: 1280px) {
        .sheet-music-bg::before {
          content: "";
          position: absolute;
          inset: 0;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.05'/%3E%3C/svg%3E");
          pointer-events: none;
          z-index: 1;
        }
    }

    .sakura-particle {
      position: absolute;
      top: -10%;
      border-radius: 10% 80% 30% 80%;
      animation: fall linear infinite;
      z-index: 2;
      will-change: transform; 
    }

    @keyframes fall {
      0% { transform: translateY(-10vh) rotate(0deg) translateX(0); opacity: 0; }
      10% { opacity: var(--target-opacity, 0.8); }
      90% { opacity: var(--target-opacity, 0.8); }
      100% { transform: translateY(110vh) rotate(360deg) translateX(50px); opacity: 0; }
    }

    .ink-text {
      color: ${KITAUJI_BROWN};
      position: relative;
    }
    .ink-text::before {
      content: attr(data-text);
      position: absolute;
      left: 1px; top: 0;
      color: rgba(120, 90, 66, 0.3);
      z-index: -1;
      opacity: 0;
      transition: opacity 0.5s;
    }
    .ink-text:hover::before { opacity: 1; }

    .log-scroll::-webkit-scrollbar { width: 3px; }
    .log-scroll::-webkit-scrollbar-track { background: rgba(120, 90, 66, 0.05); }
    .log-scroll::-webkit-scrollbar-thumb { background: ${KITAUJI_BROWN}; border-radius: 2px; }
    
    .emblem-hard-circle {
      border-radius: 50%;
      overflow: hidden;
      box-shadow: inset 0 0 0 1px rgba(120, 90, 66, 0.2);
    }

    .kitauji-emblem-filter {
      filter: sepia(1.0) hue-rotate(-15deg) saturate(0.95) brightness(0.8) contrast(1.15);
      mix-blend-mode: multiply;
      opacity: 0.95;
    }
    
    @keyframes deep-breathe {
      0%, 100% { transform: scale(1); opacity: 0.95; }
      50% { transform: scale(1.03); opacity: 1; }
    }
    
    .animate-emblem-breathe {
      animation: deep-breathe 6s ease-in-out infinite;
      will-change: transform;
    }
  `;

  useEffect(() => {
    const logs = [
      "AMADEUS SYSTEM [Ver 3.04]",
      "Loading Kitauji_Winter_Theme...",
      "Audio Driver: Euphorium_Resonance.wav",
      "Tuning: Bb Major / A=442Hz",
      "Syncing Emotional Parameters...",
      language === 'zh' ? "Subject: 黄前久美子 (3年级)" : "Subject: Oumae Kumiko (3rd Year)",
      "Status: Waiting for conductor..."
    ];

    let delay = 0;
    logs.forEach((log, i) => {
      delay += 300;
      setTimeout(() => {
        setBootLog(prev => [...prev, log]);
        if (i === logs.length - 1) {
          setTimeout(() => setShowContent(true), 500);
        }
      }, delay);
    });

    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [language]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable fullscreen: ${err.message}`);
      });
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  };

  const handleConnect = () => {
    setIsFadingOut(true);
    setTimeout(onConnect, 1500);
  };

  return (
    <div className={`fixed top-0 left-0 w-full z-[100] bg-[#f9f7f2] text-[#785A42] overflow-hidden flex flex-col items-center justify-center transition-all duration-1000 safe-area-padding`} style={{ height: 'var(--app-height)' }}>
      <style>{styles}</style>

      {/* --- CONTENT WRAPPER FOR FADE OUT --- */}
      <div className={`absolute inset-0 w-full h-full transition-all duration-1000 ease-in-out ${isFadingOut ? 'opacity-0 blur-md scale-105' : 'opacity-100 blur-0 scale-100'}`}>
        
        {/* --- BACKGROUND LAYERS (Layer 0: Absolute Fill) --- */}
        <div className="sheet-music-bg absolute inset-0 z-0"></div>

        {/* OPTIMIZATION: Use Memoized Particles */}
        {particles.map((p) => (
          <div 
            key={p.id} 
            className="sakura-particle" 
            style={{ 
              left: p.left, 
              width: p.size,
              height: p.size,
              background: p.background,
              animationDuration: p.animationDuration,
              animationDelay: p.animationDelay,
              '--target-opacity': p.opacity, 
            } as React.CSSProperties}
          ></div>
        ))}

        {/* --- FULLSCREEN TOGGLE (LEFT) --- */}
        <div className={`absolute top-8 left-6 z-50`}>
           <button 
             onClick={toggleFullscreen}
             className="p-2 rounded-full border border-[#785A42]/30 bg-white/50 backdrop-blur-sm shadow-sm text-[#785A42]/60 hover:text-[#785A42] transition-all"
             title={language === 'zh' ? '切换全屏' : 'Toggle Fullscreen'}
           >
             {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
           </button>
        </div>

        {/* --- LANGUAGE SWITCHER (RIGHT) --- */}
        <div className="absolute top-6 right-6 z-50 flex items-center gap-2 animate-[breathe_2s_infinite]">
           <div className={`px-2 py-1 rounded-full border border-[#785A42]/30 flex gap-2 bg-white/50 backdrop-blur-sm shadow-sm transition-opacity duration-500`}>
              <button 
                onClick={() => onLanguageChange('zh')}
                className={`ka-micro font-semibold px-2 py-0.5 rounded transition-all ${language === 'zh' ? 'bg-[#785A42] text-[#f9f7f2]' : 'text-[#785A42]/60 hover:text-[#785A42]'}`}
              >
                中
              </button>
              <div className="w-px h-auto bg-[#785A42]/20"></div>
              <button 
                onClick={() => onLanguageChange('en')}
                className={`ka-micro font-semibold font-elegant px-2 py-0.5 rounded transition-all ${language === 'en' ? 'bg-[#785A42] text-[#f9f7f2]' : 'text-[#785A42]/60 hover:text-[#785A42]'}`}
              >
                EN
              </button>
           </div>
        </div>

        {/* --- MAIN CONTENT (Layer 1: Safe Area Aware) --- */}
        {/* FIX: Applied 'Sandwich Fix' - Removing manual status bar div and applying padding here */}
        <div className={`relative z-30 w-full h-full flex flex-col items-center justify-center px-6 pt-[calc(env(safe-area-inset-top)+1.5rem)] pb-[calc(env(safe-area-inset-bottom)+1.5rem)] transition-all duration-1000 ${showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
          
          {/* LOGO AREA - HYBRID DESIGN */}
          <div className="relative w-[25vh] h-[25vh] min-w-[160px] min-h-[160px] md:w-[38vh] md:h-[38vh] mb-[2vh] md:mb-[3vh] flex-shrink-0 flex items-center justify-center">
            
            {/* 1. Large Outer Thin Ring (Static - Common) */}
            <svg className="absolute inset-0 w-full h-full opacity-30" viewBox="0 0 100 100">
               <circle cx="50" cy="50" r="49" fill="none" stroke="#785A42" strokeWidth="0.1" />
            </svg>

            {/* 2. DESKTOP ONLY: Rotating Text Ring (Original PC Design) */}
            <div className="hidden md:block absolute inset-[5%] w-[90%] h-[90%] animate-[spin_40s_linear_infinite]">
              <svg viewBox="0 0 100 100" className="w-full h-full">
                  <path id="textPath" d="M 50,50 m -40,0 a 40,40 0 1,1 80,0 a 40,40 0 1,1 -80,0" fill="none" />
                  <text className="fill-[#785A42] text-[5px] font-mono tracking-[0.3em] opacity-80 font-bold uppercase">
                      <textPath href="#textPath" startOffset="0%">
                      Kitauji High School Concert Band • Progressive Form • Amadeus System •
                      </textPath>
                  </text>
              </svg>
            </div>
            
            {/* 3. MOBILE ONLY: Musical Rings V13 (Euphonium Bass Clef) */}
            <div className="block md:hidden absolute inset-0 w-full h-full">
                <svg viewBox="0 0 100 100" className="w-full h-full animate-[spin_60s_linear_infinite]">
                    <g className="origin-center">
                        <g className="stroke-[#785A42]" fill="none" opacity="0.6">
                            <circle cx="50" cy="50" r="49" strokeWidth="0.1" />
                            <circle cx="50" cy="50" r="33" strokeWidth="0.1" />
                            <circle cx="50" cy="50" r="45" strokeWidth="0.2" />
                            <circle cx="50" cy="50" r="43" strokeWidth="0.2" />
                            <circle cx="50" cy="50" r="41" strokeWidth="0.2" />
                            <circle cx="50" cy="50" r="39" strokeWidth="0.2" />
                            <circle cx="50" cy="50" r="37" strokeWidth="0.2" />
                        </g>
                        <g fill="#785A42" className="font-mono" style={{ textAnchor: 'middle', dominantBaseline: 'auto' }}>
                            <g transform="rotate(350 50 50)"> <text x="50" y="7" dy="2.0" fontSize="8">𝄢</text> </g>
                            <g transform="rotate(10 50 50)"> <text x="50" y="11" dy="1.4" fontSize="6">♭</text> </g>
                            <g transform="rotate(20 50 50)"> <text x="50" y="8" dy="1.4" fontSize="6">♭</text> </g>
                            <g transform="rotate(40 50 50)"> <text x="50" y="13" dy="1.6" fontSize="5.5">♩</text> </g>
                            <g transform="rotate(55 50 50)"> <text x="50" y="9" dy="1.6" fontSize="5.5">♫</text> </g>
                            <g transform="rotate(75 50 50)"> <text x="50" y="5" dy="1.6" fontSize="5.5">♪</text> </g>
                            <g transform="rotate(90 50 50)"> <text x="50" y="9" dy="1.6" fontSize="5.5">♬</text> </g>
                            <g transform="rotate(110 50 50)"> <text x="50" y="11" dy="1.6" fontSize="5.5">♩</text> </g>
                            <g transform="rotate(130 50 50)"> <text x="50" y="9" dy="1.6" fontSize="5.5">𝄽</text> </g>
                            <g transform="rotate(150 50 50)"> <text x="50" y="7" dy="1.6" fontSize="5.5">♫</text> </g>
                            <g transform="rotate(170 50 50)"> <text x="50" y="4" dy="1.6" fontSize="5.5">♪</text> </g>
                            <g transform="rotate(190 50 50)"> <text x="50" y="9" dy="1.6" fontSize="5.5">♭</text> </g>
                            <g transform="rotate(210 50 50)"> <text x="50" y="13" dy="1.6" fontSize="5.5">♩</text> </g>
                            <g transform="rotate(230 50 50)"> <text x="50" y="11" dy="1.6" fontSize="5.5">♬</text> </g>
                            <g transform="rotate(250 50 50)"> <text x="50" y="7" dy="1.6" fontSize="5.5">♫</text> </g>
                            <g transform="rotate(270 50 50)"> <text x="50" y="13" dy="1.6" fontSize="5.5">𝅗𝅥</text> </g>
                            <g transform="rotate(290 50 50)"> <text x="50" y="9" dy="1.4" fontSize="5.5">♮</text> </g>
                            <g transform="rotate(310 50 50)"> <text x="50" y="11" dy="1.6" fontSize="5.5">♩</text> </g>
                        </g>
                    </g>
                </svg>
            </div>

            {/* 4. DESKTOP ONLY: Inner Decorative Rings (HUD Style - Original PC Design) */}
            <div className="hidden md:block absolute inset-[15%] w-[70%] h-[70%] border border-[#785A42] rounded-full opacity-20"></div>
            <div className="hidden md:block absolute inset-[18%] w-[64%] h-[64%] border border-dashed border-[#c5a059] rounded-full opacity-40 animate-[spin_20s_linear_infinite_reverse]"></div>
            
            {/* 5. THE EMBLEM */}
            <div className="relative w-[48%] h-[48%] flex items-center justify-center animate-emblem-breathe">
               {/* Original PC Glow: slightly smaller and integrated */}
               <div className="absolute inset-0 bg-[#c5a059]/10 blur-xl rounded-full scale-105"></div>
               <div className="w-full h-full emblem-hard-circle flex items-center justify-center">
                  <img 
                    src="./images/logo.png" 
                    alt="Kitauji High School Emblem" 
                    className="w-[75%] h-[75%] object-contain kitauji-emblem-filter"
                  />
               </div>
               <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-transparent via-white/30 to-transparent opacity-20 pointer-events-none mix-blend-overlay"></div>
            </div>
          </div>

          {/* TITLE SECTION */}
          <div className="text-center mb-[3vh] md:mb-[4vh] relative z-10 flex flex-col items-center">
             <div className="flex items-center gap-3 mb-[1vh] opacity-80">
                <span className="h-px w-8 bg-[#785A42]"></span>
                <span className="ka-kicker font-elegant tracking-[0.2em] text-[#785A42] font-semibold">SOUND! EUPHONIUM</span>
                <span className="h-px w-8 bg-[#785A42]"></span>
             </div>

             <h1 
               className="text-[4.2vh] md:text-[5.4vh] leading-none font-elegant font-bold tracking-[0.1em] text-[#785A42] ink-text drop-shadow-sm" 
               data-text="AMADEUS"
             >
               AMADEUS
             </h1>
             
             <div className="mt-[1.5vh] flex flex-col items-center gap-1">
                <span className="text-[1.72vh] md:text-[2vh] leading-none font-mincho font-semibold tracking-[0.04em] text-[#785A42]">
                  {language === 'zh' ? '黄前 久美子' : 'Oumae Kumiko'}
                </span>
                <span className="ka-micro font-mono tracking-[0.14em] text-[#785A42] opacity-60 uppercase mt-[0.5vh]">
                  Kitauji High School Concert Band
                </span>
             </div>
          </div>

          {/* INFO CARD */}
          <div className="w-full max-w-3xl grid grid-cols-1 md:grid-cols-2 gap-[3.8vh] md:gap-[4.8vh] mb-[3.4vh] md:mb-[4.4vh] px-6">
            <div className="hidden md:block bg-[rgba(255,255,255,0.72)] border border-[#785A42]/18 p-[1.55vh] h-[12vh] min-h-[80px] overflow-y-auto log-scroll shadow-sm rounded-sm relative backdrop-blur-[3px]">
               <div className="absolute top-0 left-1/2 -translate-x-1/2 w-16 h-4 bg-[#c5a059]/30 -mt-2 rotate-1"></div>
               <div className="mb-[0.9vh] border-b border-[#785A42]/10 pb-1 text-[0.72rem] tracking-[0.15em] text-[#785A42]/52 font-elegant font-normal uppercase">System Log</div>
               {bootLog.map((log, i) => (
                 <div key={i} className={`text-[#785A42]/92 mb-[0.42vh] flex items-center gap-2 ${language === 'en' ? 'text-[0.72rem] leading-[1.46] tracking-[0.012em]' : 'text-[0.77rem] leading-[1.48] tracking-[0.012em]'}`}>
                   <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#c5a059]/70 shadow-[0_0_0_1px_rgba(120,90,66,0.08)]"></span>
                   <span className={`truncate whitespace-nowrap ${/[\u3400-\u9fff]/.test(log) ? 'font-mincho font-medium' : 'font-elegant font-normal not-italic tracking-[0.012em] text-[#785A42]/86'}`}>{log}</span>
                 </div>
               ))}
            </div>

            <div className="bg-[#fffdf5] border-l-4 border-[#785A42] p-[1.5vh] shadow-sm relative overflow-hidden group">
               <Music className="absolute -bottom-2 -right-2 text-[#785A42] opacity-5 rotate-12" size={80} />
               <div className="flex items-start gap-3 relative z-10">
                 <div className="mt-1 p-1 bg-[#785A42]/10 rounded-full text-[#785A42]">
                    <AlertTriangle size={14} />
                 </div>
                 <div>
                    <h3 className="font-semibold font-mincho ka-section-title text-[#785A42] mb-[0.5vh] tracking-[0.03em]">
                      {t.introWarningTitle}
                    </h3>
                    <p className={`text-[#785A42]/80 text-justify ${language === 'en' ? 'text-[0.7rem] leading-snug' : 'ka-copy-sm leading-relaxed'}`}>
                      {t.introWarning}
                    </p>
                 </div>
               </div>
            </div>
          </div>

          {/* BUTTON */}
          <div className="relative z-20 mt-auto md:mt-0 mb-[2vh] md:mb-[4vh]">
            <button
              onClick={handleConnect}
              className="group relative px-10 py-3 md:px-[4vh] md:py-[2vh] overflow-hidden bg-[#785A42] text-[#f9f7f2] ka-label font-semibold transition-all duration-300 shadow-[0_4px_15px_rgba(96,65,43,0.3)] hover:shadow-[0_6px_20px_rgba(96,65,43,0.5)] rounded-sm"
            >
              <div className="absolute inset-0 bg-[#8c6045] translate-y-[100%] group-hover:translate-y-0 transition-transform duration-300 ease-in-out"></div>
              <div className="absolute top-1 left-0 w-full h-[1px] bg-[#f9f7f2] opacity-20"></div>
              <div className="absolute bottom-1 left-0 w-full h-[1px] bg-[#f9f7f2] opacity-20"></div>

              <div className="flex items-center gap-3 relative z-10 group-hover:scale-105 transition-transform">
                 <Wind className={`w-4 h-4 transition-transform duration-500 ${isFadingOut ? 'translate-x-10 opacity-0' : ''}`} />
                 <span>{t.introConnect}</span>
              </div>
            </button>
          </div>

          {/* Footer */}
          <div className="absolute bottom-3 ka-micro text-[#785A42]/40 tracking-[0.2em] font-mono flex items-center gap-2">
             <span>北宇治高校吹奏楽部</span>
             <span className="w-1 h-1 bg-[#c5a059] rounded-full"></span>
             <span>AMADEUS PROJECT</span>
          </div>

        </div>
      </div>
    </div>
  );
};
