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
        // Phase 7 Part t11_modal_toast: the toast was anchored at `top-12`
        // (48px), which sat under the iPhone notch / Dynamic Island. Add
        // env(safe-area-inset-top) so on phones the toast floats below the
        // punchhole. Desktop Electron env() is 0, so visually unchanged.
        <motion.div
          initial={{ y: -50, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -50, opacity: 0 }}
          className="fixed left-1/2 -translate-x-1/2 z-[1000000] pointer-events-none"
          style={{ top: 'calc(3rem + var(--sat))' }}
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
      )}
    </AnimatePresence>
  );
};
