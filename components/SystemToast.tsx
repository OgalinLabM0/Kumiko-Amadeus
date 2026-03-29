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
        <motion.div
          initial={{ y: -50, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -50, opacity: 0 }}
          className="fixed top-12 left-1/2 -translate-x-1/2 z-[250] pointer-events-none"
        >
          <div
            className={`
              flex items-center gap-2 px-4 py-2 rounded-full border shadow-lg backdrop-blur-md
              font-mono text-xs font-bold
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
