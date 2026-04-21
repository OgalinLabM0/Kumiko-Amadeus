// components/mobile/MobilePairingChrome.tsx
//
// Phase 7 Part t2_pairing_ui + brand-fix: shared brand shell for the
// mobile pairing gate (MobilePairingGate's Loading, Pairing, Hydrating
// views). This mirrors the IntroScreen's Kitauji palette + Amadeus
// typography so a phone landing on the PWA doesn't see a "demo" dark
// screen before the real brand tone kicks in.
//
// brand-fix (post-Phase-7): the header logo now renders `public/favicon-KA.png`
// as-is (no sepia/hue-rotate, no mix-blend, no circular crop). That PNG is
// the same file electron-builder ships as the Windows/Linux app icon, so
// the PWA header matches the PC tray/installer icon pixel-for-pixel. All
// user-facing copy was converted to zh-first with an English subtitle to
// match the desktop IntroScreen's bilingual tone.
//
// Desktop Electron never instantiates the pairing gate, so nothing in
// this file runs there. The chrome is intentionally mobile-first: one
// centered column, safe-area padding, 100dvh for iOS address-bar
// shrink, no hover-only interactions.

import React from 'react';

const BG_COLOR = '#f9f7f2';
const KITAUJI_BROWN = '#785A42';
const GOLD = '#c5a059';

const sharedStyles = `
  .ka-pair-bg {
    background-color: ${BG_COLOR};
    background-image: repeating-linear-gradient(
      transparent,
      transparent 20px,
      rgba(120, 90, 66, 0.03) 20px,
      rgba(120, 90, 66, 0.03) 21px
    );
  }
  .ka-pair-title { font-family: var(--font-elegant); color: ${KITAUJI_BROWN}; }
  .ka-pair-subtitle { font-family: var(--font-display); color: ${KITAUJI_BROWN}; }
  .ka-pair-body { font-family: var(--font-reading); color: rgba(120, 90, 66, 0.88); }
  .ka-pair-micro { font-family: var(--font-mono); color: rgba(120, 90, 66, 0.55); letter-spacing: 0.14em; }
  .ka-pair-card {
    background: rgba(255, 255, 255, 0.72);
    border: 1px solid rgba(120, 90, 66, 0.18);
    backdrop-filter: blur(3px);
    border-radius: 4px;
    box-shadow: 0 1px 3px rgba(120, 90, 66, 0.08);
  }
  .ka-pair-divider {
    height: 1px;
    width: 2.5rem;
    background-color: ${KITAUJI_BROWN};
    opacity: 0.4;
  }
  .ka-pair-dot {
    width: 0.25rem;
    height: 0.25rem;
    border-radius: 9999px;
    background-color: ${GOLD};
  }
  .ka-pair-input {
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid rgba(120, 90, 66, 0.28);
    border-radius: 4px;
    padding: 12px;
    font-size: 15px;
    min-height: 96px;
    resize: vertical;
    font-family: var(--font-mono);
    color: ${KITAUJI_BROWN};
    width: 100%;
    box-sizing: border-box;
  }
  .ka-pair-input::placeholder { color: rgba(120, 90, 66, 0.35); }
  .ka-pair-input:focus {
    outline: none;
    border-color: ${KITAUJI_BROWN};
    box-shadow: 0 0 0 2px rgba(120, 90, 66, 0.12);
  }
  .ka-pair-btn {
    width: 100%;
    min-height: 48px;
    padding: 14px 16px;
    background: ${KITAUJI_BROWN};
    color: ${BG_COLOR};
    border: none;
    border-radius: 4px;
    font-family: var(--font-elegant);
    font-weight: 600;
    font-size: 15px;
    letter-spacing: 0.12em;
    transition: transform 0.15s ease, background-color 0.2s ease;
    box-shadow: 0 4px 15px rgba(96, 65, 43, 0.22);
    position: relative;
    overflow: hidden;
  }
  .ka-pair-btn:active { transform: scale(0.98); background: #8c6045; }
  .ka-pair-btn:disabled { background: rgba(120, 90, 66, 0.35); cursor: wait; }
  .ka-pair-step {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0;
  }
  .ka-pair-step-dot {
    width: 14px;
    height: 14px;
    border-radius: 9999px;
    border: 1px solid ${KITAUJI_BROWN};
    flex-shrink: 0;
    position: relative;
  }
  .ka-pair-step-dot.done {
    background: ${KITAUJI_BROWN};
  }
  .ka-pair-step-dot.done::after {
    content: '';
    position: absolute;
    left: 3px;
    top: 6px;
    width: 3px;
    height: 6px;
    border-right: 1.5px solid ${BG_COLOR};
    border-bottom: 1.5px solid ${BG_COLOR};
    transform: rotate(45deg);
  }
  .ka-pair-step-dot.active {
    background: ${GOLD};
    animation: ka-pair-pulse 1.2s ease-in-out infinite;
  }
  @keyframes ka-pair-pulse {
    0%, 100% { opacity: 0.6; transform: scale(1); }
    50% { opacity: 1; transform: scale(1.15); }
  }
  .ka-pair-dots-animate {
    display: inline-flex;
    gap: 0.25rem;
    margin-left: 0.35rem;
  }
  .ka-pair-dots-animate span {
    width: 4px;
    height: 4px;
    border-radius: 9999px;
    background: ${KITAUJI_BROWN};
    opacity: 0.35;
    animation: ka-pair-dots 1.2s ease-in-out infinite;
  }
  .ka-pair-dots-animate span:nth-child(2) { animation-delay: 0.15s; }
  .ka-pair-dots-animate span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes ka-pair-dots {
    0%, 100% { opacity: 0.25; transform: translateY(0); }
    50% { opacity: 1; transform: translateY(-2px); }
  }
`;

interface MobilePairingChromeProps {
  children: React.ReactNode;
}

export function MobilePairingChrome({ children }: MobilePairingChromeProps) {
  return (
    <div
      className="ka-pair-bg fixed inset-0 z-[100] flex flex-col items-stretch overflow-y-auto"
      style={{
        minHeight: '100dvh',
        paddingTop: 'max(40px, var(--sat))',
        paddingBottom: 'max(24px, var(--sab))',
        paddingLeft: 'max(24px, var(--sal))',
        paddingRight: 'max(24px, var(--sar))',
      }}
    >
      <style>{sharedStyles}</style>
      <div className="w-full max-w-[28rem] mx-auto flex flex-col gap-6 py-6">
        <header className="flex flex-col items-center text-center gap-3">
          <img
            src="/favicon-KA.png"
            alt="Kumiko·Amadeus"
            width={88}
            height={88}
            className="block"
            style={{ width: 88, height: 88, objectFit: 'contain' }}
          />
          <div className="flex items-center gap-2">
            <div className="ka-pair-divider" />
            <span className="ka-pair-micro text-[10px] font-semibold uppercase">
              移动端伴侣 · Mobile Companion
            </span>
            <div className="ka-pair-divider" />
          </div>
          <h1 className="ka-pair-title text-[28px] leading-none font-bold tracking-[0.1em]">
            AMADEUS
          </h1>
          <div className="ka-pair-subtitle text-[13px] tracking-[0.04em] font-light">
            Kumiko·Amadeus
          </div>
        </header>
        {children}
        <footer
          className="mt-auto pt-6 flex items-center justify-center gap-2 ka-pair-micro text-[10px]"
          style={{ letterSpacing: '0.2em' }}
        >
          <span>北宇治高校吹奏楽部</span>
          <span className="ka-pair-dot" />
          <span>AMADEUS PROJECT</span>
        </footer>
      </div>
    </div>
  );
}

interface MobilePairingLoadingProps {
  label?: string;
  subLabel?: string;
}

export function MobilePairingLoading({ label, subLabel }: MobilePairingLoadingProps) {
  const primary = label ?? '正在连接桌面端';
  const secondary = subLabel ?? 'Connecting with your desktop';
  return (
    <div className="ka-pair-card px-5 py-6 text-center">
      <div className="ka-pair-body text-[14px] leading-relaxed">
        {primary}
        <span className="ka-pair-dots-animate" aria-hidden>
          <span />
          <span />
          <span />
        </span>
      </div>
      <div className="ka-pair-micro text-[10px] mt-1 opacity-70">
        {secondary}
      </div>
    </div>
  );
}

export interface MobilePairingStep {
  id: string;
  label: string;
  labelEn?: string;
  state: 'pending' | 'active' | 'done';
}

export function MobilePairingHydrating({ steps }: { steps: MobilePairingStep[] }) {
  return (
    <div className="ka-pair-card px-5 py-5">
      <div className="ka-pair-micro text-[10px] font-semibold uppercase mb-1">
        正在同步桌面数据
      </div>
      <div className="ka-pair-micro text-[10px] opacity-70 mb-3">
        Syncing with desktop
      </div>
      {steps.map((s) => (
        <div key={s.id} className="ka-pair-step">
          <span
            className={`ka-pair-step-dot ${s.state === 'done' ? 'done' : ''} ${s.state === 'active' ? 'active' : ''}`}
          />
          <div className="flex flex-col">
            <span
              className={`ka-pair-body text-[13px] ${s.state === 'pending' ? 'opacity-45' : 'opacity-100'}`}
            >
              {s.label}
            </span>
            {s.labelEn && (
              <span
                className={`ka-pair-micro text-[10px] ${s.state === 'pending' ? 'opacity-35' : 'opacity-60'}`}
              >
                {s.labelEn}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
