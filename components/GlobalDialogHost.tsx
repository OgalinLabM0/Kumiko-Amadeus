import React, { useEffect, useRef, useState } from 'react';
import { CustomDialog } from './settings/CustomDialog';
import type { CustomDialogIcon, CustomDialogVariant } from './settings/CustomDialog';
import { registerDialogHost } from '../services/dialogService';
import type { DialogRequest } from '../services/dialogService';
import { useAppStore } from '../store';
import { UI_TRANSLATIONS } from '../constants/uiTranslations';

/**
 * GlobalDialogHost — the single React-side recipient for requests made
 * via `dialogService.alert|confirm|prompt`. Keeps ONE CustomDialog
 * mounted (via its portal) so stacking is impossible; queued requests
 * are surfaced sequentially by dialogService itself.
 *
 * Place once near the top of the React tree (see components/App.tsx,
 * alongside <SystemToast />). Do NOT mount more than one.
 */
export const GlobalDialogHost: React.FC = () => {
  const isDarkMode = useAppStore((s) => s.isDarkMode);
  const language = useAppStore((s) => s.language) as 'en' | 'zh';
  const [current, setCurrent] = useState<DialogRequest | null>(null);
  // Track whether the dialog is "settled" (onConfirm/onCancel already
  // called) so React's close transition doesn't race into a second
  // resolve when the portal finishes animating out.
  const settledRef = useRef(false);

  useEffect(() => {
    const unregister = registerDialogHost((request) => {
      settledRef.current = false;
      setCurrent(request);
    });
    return () => {
      unregister();
    };
  }, []);

  // Default titles come from i18n so that alerts/confirms fired from
  // non-React modules still feel native to the current language.
  const t = UI_TRANSLATIONS[language] as unknown as {
    dialogDefaultTitleAlert?: string;
    dialogDefaultTitleConfirm?: string;
    dialogDefaultTitleDanger?: string;
    dialogDefaultTitlePrompt?: string;
  };

  const resolveWith = (value: unknown) => {
    if (!current || settledRef.current) return;
    settledRef.current = true;
    current.resolve(value);
    setCurrent(null);
  };

  const handleConfirm = (inputValue?: string) => {
    if (!current) return;
    if (current.kind === 'alert') resolveWith(undefined);
    else if (current.kind === 'confirm') resolveWith(true);
    else if (current.kind === 'prompt') resolveWith(inputValue ?? '');
  };

  const handleCancel = () => {
    if (!current) return;
    if (current.kind === 'alert') resolveWith(undefined);
    else if (current.kind === 'confirm') resolveWith(false);
    else if (current.kind === 'prompt') resolveWith(null);
  };

  const deriveTitle = (): string | undefined => {
    if (!current) return undefined;
    if (current.title) return current.title;
    if (current.kind === 'alert') return t.dialogDefaultTitleAlert;
    if (current.kind === 'prompt') return t.dialogDefaultTitlePrompt;
    if (current.variant === 'danger') return t.dialogDefaultTitleDanger;
    return t.dialogDefaultTitleConfirm;
  };

  const deriveIcon = (): CustomDialogIcon | undefined => {
    if (!current) return undefined;
    if (current.icon) return current.icon;
    if (current.variant === 'danger') return 'warning';
    if (current.kind === 'alert') return 'info';
    return undefined;
  };

  return (
    <CustomDialog
      isOpen={!!current}
      title={deriveTitle()}
      message={current?.message ?? ''}
      type={current?.kind ?? 'alert'}
      inputPlaceholder={current?.placeholder}
      inputDefaultValue={current?.defaultValue}
      confirmText={current?.confirmText}
      cancelText={current?.cancelText}
      variant={(current?.variant as CustomDialogVariant | undefined) ?? 'default'}
      icon={deriveIcon()}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
      isDarkMode={isDarkMode}
      language={language}
    />
  );
};
