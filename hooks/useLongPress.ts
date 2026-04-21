import { useCallback, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react';

export interface LongPressOptions {
  threshold?: number;
  moveTolerance?: number;
  onLongPress: (e: ReactTouchEvent | ReactMouseEvent) => void;
  onClick?: (e: ReactTouchEvent | ReactMouseEvent) => void;
}

export interface LongPressHandlers {
  onTouchStart: (e: ReactTouchEvent) => void;
  onTouchEnd: (e: ReactTouchEvent) => void;
  onTouchMove: (e: ReactTouchEvent) => void;
  onTouchCancel: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
}

export function useLongPress({
  threshold = 500,
  moveTolerance = 10,
  onLongPress,
  onClick,
}: LongPressOptions): LongPressHandlers {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedRef = useRef(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const onTouchStart = useCallback((e: ReactTouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    firedRef.current = false;
    startRef.current = { x: touch.clientX, y: touch.clientY };
    clearTimer();
    timerRef.current = setTimeout(() => {
      firedRef.current = true;
      onLongPress(e);
    }, threshold);
  }, [threshold, onLongPress]);

  const onTouchMove = useCallback((e: ReactTouchEvent) => {
    const touch = e.touches[0];
    if (!touch || !startRef.current) return;
    const dx = Math.abs(touch.clientX - startRef.current.x);
    const dy = Math.abs(touch.clientY - startRef.current.y);
    if (dx > moveTolerance || dy > moveTolerance) {
      clearTimer();
    }
  }, [moveTolerance]);

  const onTouchEnd = useCallback((e: ReactTouchEvent) => {
    clearTimer();
    if (!firedRef.current && onClick) {
      onClick(e);
    }
    firedRef.current = false;
    startRef.current = null;
  }, [onClick]);

  const onTouchCancel = useCallback(() => {
    clearTimer();
    firedRef.current = false;
    startRef.current = null;
  }, []);

  const onContextMenu = useCallback((e: ReactMouseEvent) => {
    if (e.button === 2 || e.type === 'contextmenu') {
      e.preventDefault();
      onLongPress(e);
    }
  }, [onLongPress]);

  return { onTouchStart, onTouchEnd, onTouchMove, onTouchCancel, onContextMenu };
}
