import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Minus, Plus, RotateCcw, X } from 'lucide-react';
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from 'framer-motion';
import { useModalPortal } from '../hooks/useModalPortal';

interface ImageViewerProps {
  src: string | null;
  onClose: () => void;
  downloadLabel: string;
}

export const ImageViewer: React.FC<ImageViewerProps> = ({ src, onClose, downloadLabel }) => {
  const [isZoomed, setIsZoomed] = useState(false);
  const zoomLevel = useMotionValue(1);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const [displayZoom, setDisplayZoom] = useState(100);
  const backdropOpacity = useTransform(y, [-200, 0, 200], [0, 1, 0]);
  const constraintsRef = useRef<HTMLDivElement>(null);
  const dismissConstraints = useMemo(() => ({ top: 0, bottom: 0 }), []);
  const renderPortal = useModalPortal();

  useEffect(() => {
    const unsubscribe = zoomLevel.on('change', (latest) => {
      setDisplayZoom(Math.round(latest * 100));
      setIsZoomed(latest > 1.05);
    });
    return unsubscribe;
  }, [zoomLevel]);

  useEffect(() => {
    setIsZoomed(false);
    zoomLevel.set(1);
    x.set(0);
    y.set(0);
  }, [src, zoomLevel, x, y]);

  const handleDragEnd = (_: any, info: any) => {
    const scale = zoomLevel.get();
    if (scale <= 1.1) {
      if (Math.abs(info.offset.y) > 150) {
        onClose();
      } else {
        animate(y, 0, { type: 'spring', stiffness: 300, damping: 30 });
      }
    }
  };

  const adjustZoom = (delta: number) => {
    const current = zoomLevel.get();
    const newZoom = Math.min(Math.max(0.5, current + delta), 5);
    animate(zoomLevel, newZoom, { type: 'spring', stiffness: 200, damping: 20 });
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    const delta = e.deltaY * -0.002;
    adjustZoom(delta);
  };

  const handleDoubleTap = () => {
    const current = zoomLevel.get();
    if (current > 1.2) {
      handleReset();
    } else {
      animate(zoomLevel, 2.5);
      setIsZoomed(true);
    }
  };

  const handleReset = () => {
    animate(zoomLevel, 1);
    animate(x, 0);
    animate(y, 0);
    setIsZoomed(false);
  };

  // Phase 7 Part t5_b3_image_viewer: portal the overlay into <body> so the
  // fixed backdrop always covers the viewport (the AppMainView host has
  // `contain: layout style` which otherwise hijacks the containing block).
  return renderPortal(
    <AnimatePresence>
      {src && (
        <motion.div
          key="image-viewer-modal"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[200] flex items-center justify-center touch-none overflow-hidden"
          onClick={(e) => e.stopPropagation()}
          onWheel={handleWheel}
        >
          <motion.div
            className="absolute inset-0 bg-black"
            style={{ opacity: isZoomed ? 1 : backdropOpacity }}
          />

          <motion.div
            className="absolute top-0 left-0 right-0 z-50 flex justify-between p-4 pointer-events-none"
            initial={{ y: -20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
          >
            <button
              onClick={onClose}
              className="p-2 bg-black/40 text-white rounded-full backdrop-blur-md pointer-events-auto hover:bg-black/60 transition-colors border border-white/10"
            >
              <X size={20} />
            </button>
            <a
              href={src}
              download={`kumiko_img_${Date.now()}.jpg`}
              className="p-2 bg-black/40 text-white rounded-full backdrop-blur-md pointer-events-auto hover:bg-black/60 transition-colors border border-white/10"
              onClick={(e) => e.stopPropagation()}
              title={downloadLabel}
            >
              <Download size={20} />
            </a>
          </motion.div>

          <motion.div
            className="absolute bottom-8 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 px-4 py-2 bg-black/60 backdrop-blur-md rounded-full border border-white/10 text-white pointer-events-auto shadow-2xl"
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.1 }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => adjustZoom(-0.5)}
              className="p-2 hover:bg-white/20 rounded-full transition-colors active:scale-90"
              title="Zoom Out"
            >
              <Minus size={18} />
            </button>

            <span className="font-mono text-xs font-bold min-w-[3rem] text-center select-none">
              {displayZoom}%
            </span>

            <button
              onClick={() => adjustZoom(0.5)}
              className="p-2 hover:bg-white/20 rounded-full transition-colors active:scale-90"
              title="Zoom In"
            >
              <Plus size={18} />
            </button>

            <div className="w-px h-4 bg-white/20 mx-1"></div>

            <button
              onClick={handleReset}
              className="p-2 hover:bg-white/20 rounded-full transition-colors active:scale-90"
              title="Reset View"
            >
              <RotateCcw size={16} />
            </button>
          </motion.div>

          <div ref={constraintsRef} className="absolute inset-0 pointer-events-none" />

          <motion.img
            key={src}
            src={src}
            alt="Full View"
            className="relative z-10 max-w-full max-h-full object-contain cursor-grab active:cursor-grabbing select-none"
            style={{ x, y, scale: zoomLevel }}
            drag={true}
            dragConstraints={isZoomed ? undefined : dismissConstraints}
            dragElastic={isZoomed ? 0.1 : 0.8}
            dragMomentum={false}
            onDragEnd={handleDragEnd}
            onDoubleClick={handleDoubleTap}
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
};
