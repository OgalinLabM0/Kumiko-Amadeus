/**
 * dialogService — programmatic alert/confirm/prompt backed by a single
 * React host (<GlobalDialogHost />) that renders <CustomDialog>. Any
 * module (actions, services, hooks, non-React utils) can `await
 * dialogService.confirm(...)` exactly like `window.confirm`, but the
 * UI stays consistent with the rest of the app.
 *
 * Flow:
 *   - A React tree mounts <GlobalDialogHost /> exactly once, which
 *     calls `registerDialogHost(handler)` on mount and unregisters on
 *     unmount.
 *   - Call sites `await dialogService.{alert,confirm,prompt}(init)`.
 *     The service enqueues the request and hands the NEXT request to
 *     the host when the host is idle.
 *   - The host renders one dialog at a time. When the user accepts or
 *     cancels, the host invokes `request.resolve(value)`; the service
 *     then marks itself idle and dispatches the next queued request.
 *
 * Before the host is mounted (e.g. during very early app boot) calls
 * fall back to the native window.alert / window.confirm / window.prompt
 * so existing code paths never deadlock waiting for a host that is not
 * yet alive. Once the host is registered, every subsequent call goes
 * through the queue, irrespective of earlier fallbacks.
 */

export type DialogVariant = 'default' | 'danger';
export type DialogIcon = 'info' | 'warning' | 'error' | 'success';

export interface AlertRequestInit {
  title?: string;
  message: string;
  confirmText?: string;
  icon?: DialogIcon;
}

export interface ConfirmRequestInit {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: DialogVariant;
  icon?: DialogIcon;
}

export interface PromptRequestInit {
  title?: string;
  message: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
  icon?: DialogIcon;
}

export interface DialogRequest {
  id: number;
  kind: 'alert' | 'confirm' | 'prompt';
  title?: string;
  message: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: DialogVariant;
  icon?: DialogIcon;
  resolve: (value: unknown) => void;
}

type Host = (request: DialogRequest) => void;

let host: Host | null = null;
let queue: DialogRequest[] = [];
let isBusy = false;
let nextId = 1;

function dispatchNext() {
  if (isBusy || !host || queue.length === 0) return;
  const next = queue.shift()!;
  isBusy = true;
  const inner = next.resolve;
  const wrapped = (value: unknown) => {
    inner(value);
    isBusy = false;
    dispatchNext();
  };
  host({ ...next, resolve: wrapped });
}

export function registerDialogHost(handler: Host): () => void {
  host = handler;
  dispatchNext();
  return () => {
    if (host === handler) host = null;
  };
}

function enqueue<T>(partial: Omit<DialogRequest, 'id' | 'resolve'>): Promise<T> {
  return new Promise<T>((resolve) => {
    const entry: DialogRequest = {
      ...partial,
      id: nextId++,
      resolve: resolve as (value: unknown) => void,
    };
    queue.push(entry);
    dispatchNext();
  });
}

function fallbackAlert(init: AlertRequestInit): Promise<void> {
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(init.title ? `${init.title}\n\n${init.message}` : init.message);
  }
  return Promise.resolve();
}

function fallbackConfirm(init: ConfirmRequestInit): Promise<boolean> {
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    return Promise.resolve(
      window.confirm(init.title ? `${init.title}\n\n${init.message}` : init.message)
    );
  }
  return Promise.resolve(false);
}

function fallbackPrompt(init: PromptRequestInit): Promise<string | null> {
  if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
    return Promise.resolve(
      window.prompt(
        init.title ? `${init.title}\n\n${init.message}` : init.message,
        init.defaultValue ?? ''
      )
    );
  }
  return Promise.resolve(null);
}

export const dialogService = {
  alert(init: AlertRequestInit | string): Promise<void> {
    const base: AlertRequestInit =
      typeof init === 'string' ? { message: init } : init;
    if (!host) return fallbackAlert(base);
    return enqueue<void>({
      kind: 'alert',
      title: base.title,
      message: base.message,
      confirmText: base.confirmText,
      icon: base.icon,
    });
  },

  confirm(init: ConfirmRequestInit | string): Promise<boolean> {
    const base: ConfirmRequestInit =
      typeof init === 'string' ? { message: init } : init;
    if (!host) return fallbackConfirm(base);
    return enqueue<boolean>({
      kind: 'confirm',
      title: base.title,
      message: base.message,
      confirmText: base.confirmText,
      cancelText: base.cancelText,
      variant: base.variant,
      icon: base.icon,
    });
  },

  prompt(init: PromptRequestInit | string): Promise<string | null> {
    const base: PromptRequestInit =
      typeof init === 'string' ? { message: init } : init;
    if (!host) return fallbackPrompt(base);
    return enqueue<string | null>({
      kind: 'prompt',
      title: base.title,
      message: base.message,
      placeholder: base.placeholder,
      defaultValue: base.defaultValue,
      confirmText: base.confirmText,
      cancelText: base.cancelText,
      icon: base.icon,
    });
  },
};
