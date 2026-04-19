
import React, { memo, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { KUMIKO_EMOTION_IMAGES } from '../constants';
import { EmotionType } from '../types';

interface KumikoAvatarProps {
  isTalking: boolean;
  emotion: EmotionType;
  isDarkMode: boolean;
}

export const KumikoAvatar: React.FC<KumikoAvatarProps> = memo(({ isTalking, emotion, isDarkMode }) => {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
        if (document.documentElement.hasAttribute('data-resizing')) return;
        setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);
  
  const getBodyAnimation = (emo: EmotionType) => {
     if (isMobile) return 'animate-fake-live2d';
     if (['happy', 'smug', 'surprised'].includes(emo)) return 'animate-[bounce_2s_infinite]';
     if (['angry', 'confused', 'confused_2', 'worried', 'worried_2'].includes(emo)) return 'animate-[shake_0.5s_infinite]';
     return 'animate-fake-live2d';
  };
  
  const ringColorClass = isDarkMode
    ? (emotion === 'angry' ? 'text-red-500' : 'text-yellow-500')
    : (emotion === 'angry' ? 'text-red-500' : 'text-yellow-600');

  const customStyles = `
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-2px) rotate(-1deg); }
      75% { transform: translateX(2px) rotate(1deg); }
    }
    
    @keyframes simple-breathe {
      0%, 100% { transform: translateY(0) translateZ(0); }
      50% { transform: translateY(-3px) translateZ(0); }
    }

    @keyframes sway {
      0%, 100% { transform: rotate(-1deg) translateY(0); }
      50% { transform: rotate(1deg) translateY(-2px); }
    }
    
    @keyframes breathe {
      0%, 100% { transform: scaleY(1); }
      50% { transform: scaleY(1.02); }
    }

    .animate-fake-live2d {
      animation: simple-breathe 5s ease-in-out infinite;
    }

    .img-glow {
      will-change: transform;
      transition: filter 0.8s ease;
    }
    
    @media (max-width: 768px) {
        .img-glow {
            ${isDarkMode ? 'filter: brightness(0.9);' : 'filter: opacity(0.95) contrast(1.02);'}
        }
    }

    .avatar-mask-container {
      mask-image: linear-gradient(to bottom, black 85%, transparent 100%);
      -webkit-mask-image: linear-gradient(to bottom, black 85%, transparent 100%);
      transform: translateZ(0);
    }

    @media (min-width: 768px) {
      .animate-fake-live2d {
        animation: sway 6s ease-in-out infinite, breathe 4s ease-in-out infinite;
      }

      .img-glow {
        ${isDarkMode 
          ? `filter: brightness(1.05) 
             drop-shadow(0 0 2px rgba(255, 255, 255, 0.8)) 
             drop-shadow(0 0 10px rgba(255, 255, 255, 0.5)) 
             drop-shadow(0 0 25px rgba(234, 179, 8, 0.3));` 
          : `filter: contrast(1.02) 
             drop-shadow(0 0 1px #ffffff) 
             drop-shadow(0 0 3px rgba(255, 255, 255, 0.5)) 
             drop-shadow(0 15px 30px rgba(120, 90, 66, 0.2));`
        }
      }

      .avatar-mask-container {
        mask-image: linear-gradient(to bottom, black 92%, transparent 100%) !important;
        -webkit-mask-image: linear-gradient(to bottom, black 92%, transparent 100%) !important;
      }
    }
  `;

  return (
    // FIX: Reduced pb from 14vh to 10vh to lower the position slightly
    <div className="relative w-full h-full flex items-end justify-center pointer-events-none select-none overflow-hidden group pb-[10vh] md:pb-0">
      <style>{customStyles}</style>

      <div 
        // FIX: Reduced mobile height from 55dvh to 48dvh to shrink mobile scale
        className={`relative z-10 w-full h-[48dvh] md:h-[90dvh] flex items-end justify-center avatar-mask-container -translate-x-[26%]`}
      >
        {isMobile ? (
            <AnimatePresence mode='popLayout'>
              <motion.img 
                key={emotion}
                src={KUMIKO_EMOTION_IMAGES[emotion]} 
                alt={`Oumae Kumiko - ${emotion}`} 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: "linear" }}
                // Keep height 100% relative to the new smaller container
                className={`
                  ${getBodyAnimation(emotion)}
                  absolute bottom-0
                  h-auto w-auto
                  max-h-[100%] max-w-[160%]
                  object-contain object-bottom
                  img-glow
                  -translate-y-[2%]
                  ${isTalking ? 'scale-[1.01]' : 'scale-100'}
                `}
                loading="eager"
                decoding="async" 
              />
            </AnimatePresence>
        ) : (
            Object.entries(KUMIKO_EMOTION_IMAGES).map(([emoKey, src]) => {
              const isActive = emotion === emoKey;
              return (
                <img 
                  key={emoKey}
                  src={src} 
                  alt={`Oumae Kumiko - ${emoKey}`} 
                  className={`
                    ${getBodyAnimation(emotion)}
                    absolute bottom-0
                    h-auto w-auto
                    max-h-[75%] max-w-[140%] lg:max-w-[110%] xl:max-w-[100%]
                    object-contain object-bottom
                    img-glow
                    -translate-y-[5%]
                    transition-all duration-500 ease-in-out
                    ${isActive ? 'opacity-100 z-10' : 'opacity-0 z-0'}
                    ${isTalking && isActive ? 'scale-[1.01]' : 'scale-100'}
                  `}
                  loading="eager"
                  decoding="async"
                />
              );
            })
        )}
      </div>

      <div className={`hidden md:block absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-0 opacity-30 md:opacity-50 transition-colors duration-500 pointer-events-none ${ringColorClass} w-[160%] max-w-[65vh] aspect-square`}>
        <div className="absolute inset-0 border border-current rounded-full animate-[spin_20s_linear_infinite]"></div>
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[92%] h-[92%] border border-dashed border-current rounded-full animate-[spin_15s_linear_infinite_reverse]"></div>
      </div>
    </div>
  );
});
