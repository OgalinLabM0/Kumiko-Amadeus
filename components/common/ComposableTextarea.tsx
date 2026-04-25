// v2.14.10 Y.0 — IME-safe controlled <textarea> drop-in.
// See ComposableInput.tsx for the full rationale; this is the same
// composition-event guard for <textarea> elements (memory entries,
// diary body, sovits reference prompts, message edit, etc.).

import React, { useRef, forwardRef } from 'react';

export type ComposableTextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const ComposableTextarea = forwardRef<HTMLTextAreaElement, ComposableTextareaProps>(
  function ComposableTextarea(
    { onChange, onCompositionStart, onCompositionEnd, ...rest },
    ref,
  ) {
    const isComposingRef = useRef(false);
    return (
      <textarea
        ref={ref}
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
