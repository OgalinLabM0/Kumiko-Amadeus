// v2.14.11 — IME-safe controlled <textarea> drop-in (deeper fix for v2.14.10).
// Same rationale as ComposableInput.tsx: React's per-commit controlled-input
// enforcement (`node.value = props.value` even when the prop didn't change)
// kills Chinese IME composition on Android WebView whenever an unrelated
// parent re-render commits mid-composition. We make the textarea uncontrolled
// at React's layer and mirror the parent's `value` prop manually in a
// useEffect that respects isComposingRef.

import React, { useRef, useEffect, useImperativeHandle, forwardRef } from 'react';

export type ComposableTextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const NATIVE_TEXTAREA_VALUE_SETTER =
  typeof HTMLTextAreaElement !== 'undefined'
    ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    : undefined;

function setNativeTextareaValue(el: HTMLTextAreaElement, value: string) {
  if (NATIVE_TEXTAREA_VALUE_SETTER) {
    NATIVE_TEXTAREA_VALUE_SETTER.call(el, value);
  } else {
    el.value = value;
  }
}

export const ComposableTextarea = forwardRef<HTMLTextAreaElement, ComposableTextareaProps>(
  function ComposableTextarea(
    { onChange, onCompositionStart, onCompositionEnd, value, defaultValue, ...rest },
    ref,
  ) {
    const isComposingRef = useRef(false);
    const innerRef = useRef<HTMLTextAreaElement | null>(null);

    useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement, []);

    useEffect(() => {
      const el = innerRef.current;
      if (!el) return;
      if (value == null) return;
      if (isComposingRef.current) return;
      const next = String(value);
      if (el.value !== next) {
        setNativeTextareaValue(el, next);
      }
    });

    return (
      <textarea
        ref={innerRef}
        defaultValue={value == null ? defaultValue : String(value)}
        {...rest}
        onChange={(e) => {
          if (!isComposingRef.current) onChange?.(e);
        }}
        onCompositionStart={(e) => {
          isComposingRef.current = true;
          onCompositionStart?.(e);
        }}
        onCompositionEnd={(e) => {
          isComposingRef.current = false;
          onCompositionEnd?.(e);
          onChange?.(e as unknown as React.ChangeEvent<HTMLTextAreaElement>);
        }}
      />
    );
  },
);
