import React from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

export const LoadingDataScreen: React.FC = () => {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[#f9f7f2] dark:bg-[#161616]">
      <div className="animate-pulse flex flex-col items-center">
        <div className="w-12 h-12 border-4 border-orange-500 border-t-transparent rounded-full animate-spin"></div>
        <p className="mt-4 ka-kicker font-mono text-orange-600 dark:text-orange-400">LOADING DATA...</p>
      </div>
    </div>
  );
};

interface AppConnectingOverlayProps {
  isOpen: boolean;
}

export const AppConnectingOverlay: React.FC<AppConnectingOverlayProps> = ({ isOpen }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center text-yellow-600 backdrop-blur-sm gap-3" style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.8) 30%, rgba(0,0,0,0) 100%)' }}>
      <Loader2 className="animate-spin" size={24} />
      <span className="ka-kicker font-mono tracking-[0.2em]">ESTABLISHING NEURAL LINK...</span>
    </div>
  );
};

interface AppErrorOverlayProps {
  isOpen: boolean;
  onReconfigure: () => void;
}

export const AppErrorOverlay: React.FC<AppErrorOverlayProps> = ({ isOpen, onReconfigure }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center text-red-500 backdrop-blur-sm gap-4 p-6 text-center" style={{ background: 'radial-gradient(circle, rgba(0,0,0,0.9) 30%, rgba(0,0,0,0) 100%)' }}>
      <AlertTriangle size={48} className="mb-2" />
      <h2 className="font-mincho text-xl font-semibold tracking-[0.18em]">NEURAL LINK FAILED</h2>
      <p className="ka-copy-sm opacity-70">CONNECTION TERMINATED. CHECK SIGNAL STRENGTH.</p>
      <button
        onClick={onReconfigure}
        className="mt-4 px-6 py-2 border border-red-500 text-red-500 hover:bg-red-500 hover:text-white transition-colors ka-label tracking-[0.14em]"
      >
        RECONFIGURE API KEY
      </button>
    </div>
  );
};
