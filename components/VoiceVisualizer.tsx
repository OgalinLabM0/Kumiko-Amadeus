
import React, { memo } from 'react';

interface VoiceVisualizerProps {
  isTalking: boolean;
  isDarkMode: boolean;
  label?: string;
}

export const VoiceVisualizer: React.FC<VoiceVisualizerProps> = memo(({ isTalking, isDarkMode, label }) => {
  const colorClass = isDarkMode ? 'bg-amber-400' : 'bg-[#b8860b]';
  const glowClass = isDarkMode ? 'shadow-[0_0_10px_rgba(251,191,36,0.4)]' : 'shadow-[0_0_5px_rgba(184,134,11,0.3)]';
  const borderClass = isDarkMode ? 'border-amber-400' : 'border-[#b8860b]';

  return (
    <div className="flex items-center gap-4 p-2 transition-opacity duration-500" style={{ opacity: isTalking ? 1 : 0.3 }}>
      <div className={`hidden md:block text-[10px] font-mono tracking-widest ${isDarkMode ? 'text-amber-400' : 'text-[#b8860b]'}`}>
        {label || "VOICE_SYNC"}
        <div className="h-[2px] w-full bg-current opacity-30 mt-1"></div>
      </div>

      {/* Main Visualizer Container */}
      <div className="relative w-12 h-12 flex items-center justify-center">
        
        {/* Outer Rotating Ring (Tech Vibe) */}
        <div className={`absolute inset-0 border border-dashed rounded-full ${isDarkMode ? 'opacity-60' : 'opacity-40'} animate-[spin_4s_linear_infinite] ${borderClass}`}></div>
        
        {/* Inner Counter-Rotating Ring */}
        <div className={`absolute inset-1 border-[2px] border-t-transparent border-l-transparent rounded-full ${isDarkMode ? 'opacity-80' : 'opacity-60'} animate-[spin_3s_linear_infinite_reverse] ${borderClass}`}></div>

        {/* Center Pulsing Core */}
        <div className={`w-2 h-2 rounded-full ${colorClass} ${glowClass} animate-pulse`}></div>

        {/* Wave Bars (Overlaying the core) */}
        <div className="absolute flex items-center justify-center gap-[2px] h-full w-full">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className={`w-[3px] rounded-full transition-all duration-300 ${colorClass}`}
              style={{
                height: isTalking ? `${Math.max(20, Math.random() * 80)}%` : '10%',
                opacity: isTalking ? 0.8 : 0.2,
                animation: isTalking ? `breathe 0.5s ease-in-out infinite alternate ${i * 0.1}s` : 'none'
              }}
            />
          ))}
        </div>
      </div>
      
      {/* Digital Readout decorative */}
      <div className="flex flex-col gap-[2px]">
         {[1, 2, 3].map(i => (
             <div key={i} className={`w-1 h-1 rounded-full ${colorClass} opacity-${i * 30}`}></div>
         ))}
      </div>
    </div>
  );
});
