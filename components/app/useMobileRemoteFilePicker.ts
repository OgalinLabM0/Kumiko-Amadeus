// components/app/useMobileRemoteFilePicker.ts
//
// Phase 6 Part C4 glue between useLocalFileBackup (which needs to resolve a
// (filePath, fileName) pair for the LOCAL tab on the AuthScreen and the
// Backup section on the SettingsPanel) and MobileRemoteFileBrowser (which
// renders the actual picker UI on the phone).
//
// The hook turns the imperative "pickX()" calls the backup hook wants into
// a render-tree-friendly state machine:
//
//   1. Caller awaits pickOpen() / pickCreate().
//   2. The hook opens the browser overlay and stores a deferred resolver.
//   3. User taps a file (or saves a name) → onSelect → resolver fires with
//      the chosen { filePath, fileName }.
//   4. User taps the close button → resolver fires with `null` (canceled).
//
// Rendering is delegated back to the caller via `browserElement`, which is
// the raw React element the caller mounts anywhere in its tree. The hook
// itself is agnostic to where the portal gets placed.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { Language } from '../../types';
import {
  MobileRemoteFileBrowser,
  type MobileRemoteFileBrowserMode,
  type MobileRemoteFileBrowserResult,
} from '../MobileRemoteFileBrowser';

export interface MobilePickResult {
  filePath: string;
  fileName: string;
  mode: MobileRemoteFileBrowserMode;
}

export interface UseMobileRemoteFilePickerInput {
  language: Language;
  isDarkMode?: boolean;
}

export interface UseMobileRemoteFilePickerResult {
  pickOpen: (opts?: { acceptExtensions?: string[] }) => Promise<MobilePickResult | null>;
  pickCreate: (opts?: { defaultFileName?: string; acceptExtensions?: string[] }) => Promise<MobilePickResult | null>;
  /** Always returns a rendered element (the browser stays permanently
   *  mounted for instant first open; closed state is driven by CSS
   *  visibility/opacity toggling inside the browser itself). */
  browserElement: React.ReactElement;
  isOpen: boolean;
}

interface PickerState {
  open: boolean;
  mode: MobileRemoteFileBrowserMode;
  defaultFileName?: string;
  acceptExtensions?: string[];
}

export function useMobileRemoteFilePicker({
  language,
  isDarkMode = true,
}: UseMobileRemoteFilePickerInput): UseMobileRemoteFilePickerResult {
  const [state, setState] = useState<PickerState>({ open: false, mode: 'open' });
  const deferredRef = useRef<((v: MobilePickResult | null) => void) | null>(null);

  const settle = useCallback((value: MobilePickResult | null) => {
    const resolver = deferredRef.current;
    deferredRef.current = null;
    setState(prev => ({ ...prev, open: false }));
    if (resolver) resolver(value);
  }, []);

  const pickOpen = useCallback((opts?: { acceptExtensions?: string[] }): Promise<MobilePickResult | null> => {
    return new Promise((resolve) => {
      if (deferredRef.current) {
        deferredRef.current(null);
      }
      deferredRef.current = resolve;
      setState({
        open: true,
        mode: 'open',
        acceptExtensions: opts?.acceptExtensions,
      });
    });
  }, []);

  const pickCreate = useCallback((opts?: { defaultFileName?: string; acceptExtensions?: string[] }): Promise<MobilePickResult | null> => {
    return new Promise((resolve) => {
      if (deferredRef.current) {
        deferredRef.current(null);
      }
      deferredRef.current = resolve;
      setState({
        open: true,
        mode: 'create',
        defaultFileName: opts?.defaultFileName,
        acceptExtensions: opts?.acceptExtensions,
      });
    });
  }, []);

  const handleSelect = useCallback((res: MobileRemoteFileBrowserResult) => {
    settle({ filePath: res.filePath, fileName: res.fileName, mode: res.mode });
  }, [settle]);

  const handleClose = useCallback(() => {
    settle(null);
  }, [settle]);

  const browserElement = useMemo<React.ReactElement>(() => {
    return React.createElement(MobileRemoteFileBrowser, {
      isOpen: state.open,
      mode: state.mode,
      language,
      isDarkMode,
      defaultFileName: state.defaultFileName,
      acceptExtensions: state.acceptExtensions,
      onSelect: handleSelect,
      onClose: handleClose,
    });
  }, [state, language, isDarkMode, handleSelect, handleClose]);

  return {
    pickOpen,
    pickCreate,
    browserElement,
    isOpen: state.open,
  };
}

export default useMobileRemoteFilePicker;
