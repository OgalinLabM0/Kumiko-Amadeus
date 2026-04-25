// v2.14.12 — IME-safe controlled <input> drop-in (third iteration).
//
// History recap:
//   v2.14.10: wrapped onChange with composition guard. Insufficient because
//             React's controlled-input enforcement still runs on every
//             commit and overwrites the DOM mid-composition.
//   v2.14.11: switched to defaultValue + manual sync via useEffect to bypass
//             React's per-commit enforcement. Insufficient because (a) the
//             useEffect had no deps so it fired on every render, including
//             irrelevant 1s setInterval re-renders from useScheduledReminders /
//             chatActions countdown / TaskPanel nowTick / etc; and (b) some
//             Android IMEs (Sogou / Baidu / Google Pinyin / Gboard 9-grid /
//             handwriting) don't fire compositionstart at all, or fire
//             compositionend prematurely between candidates, leaving
//             isComposingRef.current === false during what is logically still
//             active composition. The combination meant that on a 1s tick the
//             effect ran, isComposingRef was false, el.value="ni" (IME ghost),
//             next="" (parent state), and we wrote DOM = "" — wiping the IME.
//
// What v2.14.12 does (three layers of defense, any one would help, all three
// stack so a regression in one doesn't break the whole flow):
//
//   Layer 1 — useEffect [value] dep:
//     The DOM-sync effect now ONLY runs when the parent's `value` prop
//     actually changes. The 1s setInterval-driven re-renders (which don't
//     change value) no longer trigger the sync path at all, eliminating the
//     entire class of "spurious DOM write during composition" bugs regardless
//     of whether isComposingRef is accurate.
//
//   Layer 2 — nativeEvent.isComposing in onChange:
//     Some IMEs deliver input events with `inputEvent.isComposing === true`
//     but never fire compositionstart. We check both isComposingRef AND the
//     native event flag, and update isComposingRef defensively when the
//     native event indicates composition. This catches IMEs that skip
//     compositionstart entirely, plus the inputType='insertCompositionText'
//     marker as an additional signal.
//
//   Layer 3 — onCompositionUpdate sets isComposingRef = true:
//     For IMEs that fire compositionend prematurely between candidates and
//     then continue with another implicit composition, compositionupdate
//     usually still fires for the ongoing composition. Re-arming
//     isComposingRef on every compositionupdate event covers that race.
//
// We still go through the native HTMLInputElement prototype value setter on
// the rare DOM-write path so React's internal valueTracker stays in sync —
// otherwise the next user keystroke after a programmatic clear-on-send
// wouldn't fire onChange (React would think the value hadn't changed).

import React, { useRef, useEffect, useImperativeHandle, forwardRef } from 'react';

export type ComposableInputProps = React.InputHTMLAttributes<HTMLInputElement>;

const NATIVE_INPUT_VALUE_SETTER =
  typeof HTMLInputElement !== 'undefined'
    ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    : undefined;

function setNativeInputValue(el: HTMLInputElement, value: string) {
  if (NATIVE_INPUT_VALUE_SETTER) {
    NATIVE_INPUT_VALUE_SETTER.call(el, value);
  } else {
    el.value = value;
  }
}

function isCompositionInputType(inputType: string | undefined): boolean {
  if (!inputType) return false;
  // Composition-related InputEvent types defined by the Input Events spec:
  // https://www.w3.org/TR/input-events-2/#interface-InputEvent-Attributes
  return (
    inputType === 'insertCompositionText' ||
    inputType === 'deleteCompositionText' ||
    inputType === 'insertFromComposition' ||
    inputType === 'deleteByComposition'
  );
}

export const ComposableInput = forwardRef<HTMLInputElement, ComposableInputProps>(
  function ComposableInput(
    { onChange, onCompositionStart, onCompositionUpdate, onCompositionEnd, value, defaultValue, ...rest },
    ref,
  ) {
    const isComposingRef = useRef(false);
    const innerRef = useRef<HTMLInputElement | null>(null);

    useImperativeHandle(ref, () => innerRef.current as HTMLInputElement, []);

    useEffect(() => {
      const el = innerRef.current;
      if (!el) return;
      if (value == null) return;
      if (isComposingRef.current) return;
      const next = String(value);
      if (el.value !== next) {
        setNativeInputValue(el, next);
      }
    }, [value]);

    return (
      <input
        ref={innerRef}
        defaultValue={value == null ? defaultValue : String(value)}
        {...rest}
        onChange={(e) => {
          const native = e.nativeEvent as InputEvent;
          const composingByNative = !!native.isComposing || isCompositionInputType(native.inputType);
          if (composingByNative) isComposingRef.current = true;
          if (isComposingRef.current) return;
          onChange?.(e);
        }}
        onCompositionStart={(e) => {
          isComposingRef.current = true;
          onCompositionStart?.(e);
        }}
        onCompositionUpdate={(e) => {
          isComposingRef.current = true;
          onCompositionUpdate?.(e);
        }}
        onCompositionEnd={(e) => {
          isComposingRef.current = false;
          onCompositionEnd?.(e);
          onChange?.(e as unknown as React.ChangeEvent<HTMLInputElement>);
        }}
      />
    );
  },
);
