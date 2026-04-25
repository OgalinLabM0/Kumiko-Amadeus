import React, { useEffect, useRef } from 'react';
import { Info } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

interface SystemToastProps {
  message: string | null;
  onClose: () => void;
  isDarkMode: boolean;
}

export const SystemToast: React.FC<SystemToastProps> = ({ message, onClose, isDarkMode }) => {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => onCloseRef.current(), 5000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  return (
    <AnimatePresence>
      {message && (
        // v2.14.6 D.2: split into two layers to fix the off-centre toast.
        //
        // The v2.14.5 single-motion-div setup applied
        //   `fixed left-1/2 -translate-x-1/2`
        // to the same element that framer-motion was animating. After the
        // enter animation finished, framer wrote
        //   `transform: translate(0px, 0px)`
        // inline on the element, which OVERRODE Tailwind's
        //   `--tw-translate-x: -50%`
        // utility (because inline `style` wins over CSS class transforms).
        // The result was the element rendered at `left: 50%` with NO
        // negative-half-width offset, i.e. the toast's left edge sat on
        // the screen's centre line — visibly off to the right.
        //
        // Fix: outer non-motion <div> owns positioning + horizontal
        // centring (`left-1/2 -translate-x-1/2`). Inner motion.div ONLY
        // animates y/opacity — its inline `transform: translate(0px, 0px)`
        // is now *relative to the centred wrapper*, so the toast is
        // pixel-perfect centred regardless of animation state.
        //
        // Phase 7 Part t11_modal_toast: kept the safe-area `top` so on
        // phones the toast still floats below the notch / Dynamic Island.
        // Desktop Electron env() is 0, so visually unchanged.
        <div
          className="fixed left-1/2 -translate-x-1/2 z-[1000000] pointer-events-none"
          style={{ top: 'calc(3rem + var(--sat))' }}
        >
          <motion.div
            initial={{ y: -50, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -50, opacity: 0 }}
          >
            {/* P2 #43: screen readers need role="status" + aria-live to announce
                transient toasts. Before this the message was visually shown but
                invisible to assistive tech. `polite` keeps it non-interrupting. */}
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className={`
                flex items-center gap-2 px-4 py-2 rounded-full border shadow-lg backdrop-blur-md
                ka-copy-sm font-semibold
                ${isDarkMode
                  ? 'bg-black/80 border-yellow-500/50 text-yellow-500 shadow-yellow-900/20'
                  : 'bg-white/90 border-yellow-600/50 text-yellow-700 shadow-yellow-600/10'
                }
              `}
            >
              <Info size={14} className="flex-shrink-0" />
              <span>{message}</span>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
