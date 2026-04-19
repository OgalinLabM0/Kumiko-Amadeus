import { useEffect } from 'react';

// Shared Esc-to-close behaviour for modal-style overlays (P2 #42). We were
// shipping several modals (CustomDialog, FullGuideModal, DiaryBackfillDialog,
// the PortalModal on AuthScreen, the PinnedModal in MemoryPanel, etc.) none
// of which responded to the Escape key, which is a baseline keyboard
// accessibility expectation.
//
// Keeping this as a hook (rather than a wrapper component) means each modal
// keeps ownership of its own DOM — we just listen for Esc while the modal
// is open and forward the intent to the component's existing onClose path.
// Usage:
//   useModalKeyboard({ isOpen, onClose });
//
// Pass `false` for `isOpen` to skip binding entirely (no listener, no cleanup).
export function useModalKeyboard(options: { isOpen: boolean; onClose: () => void; enabled?: boolean }) {
  const { isOpen, onClose, enabled = true } = options;
  useEffect(() => {
    if (!isOpen || !enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // `keydown` fires before most other handlers so Esc can pre-empt in-flight
    // typing on textarea/inputs inside the modal.
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, enabled, onClose]);
}
