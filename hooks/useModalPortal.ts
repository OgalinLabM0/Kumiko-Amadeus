import { useEffect, useState, useCallback, ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Phase 7 modal-portal root: render a modal / overlay into `document.body`
 * so its `position: fixed` containing block is the viewport instead of an
 * ancestor that has `contain: layout|paint`, `transform`, `filter`,
 * `will-change: transform`, etc.
 *
 * Hosts currently hijacking fixed-descendants:
 *  - AppMainView root (`contain: layout style`)
 *  - DiaryPanel root (`contain: layout style` + `transform` + safe-area padding)
 *  - SettingsPanel `ka-settings-shell` (`contain: layout style paint` + `transform`)
 *  - MemoryPanel inner sheet (`contain` + `transform`)
 *
 * Use it for every full-bleed `fixed inset-0` modal / overlay rendered
 * inside one of those hosts so the backdrop truly covers the viewport
 * (especially iOS PWA home-indicator + notch).
 */
export function useModalPortal() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  return useCallback(
    (children: ReactNode) => {
      if (!mounted || typeof document === 'undefined') return null;
      return createPortal(children, document.body);
    },
    [mounted],
  );
}
