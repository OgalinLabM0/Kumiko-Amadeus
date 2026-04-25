// v2.14.12 — IME-safe controlled <textarea> drop-in (third iteration).
// See ComposableInput.tsx for the full rationale and three-layer defense
// design. This file is the textarea-shaped twin: same useEffect [value] dep,
// same nativeEvent.isComposing + inputType backup detection in onChange,
// same onCompositionUpdate isComposingRef rearm.

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

function isCompositionInputType(inputType: string | undefined): boolean {
  if (!inputType) return false;
  return (
    inputType === 'insertCompositionText' ||
    inputType === 'deleteCompositionText' ||
    inputType === 'insertFromComposition' ||
    inputType === 'deleteByComposition'
  );
}

export const ComposableTextarea = forwardRef<HTMLTextAreaElement, ComposableTextareaProps>(
  function ComposableTextarea(
    { onChange, onCompositionStart, onCompositionUpdate, onCompositionEnd, value, defaultValue, ...rest },
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
    }, [value]);

    return (
      <textarea
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
          onChange?.(e as unknown as React.ChangeEvent<HTMLTextAreaElement>);
        }}
      />
    );
  },
);
