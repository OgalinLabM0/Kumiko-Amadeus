// v2.14.10 Y.0 — IME-safe controlled <input> drop-in.
//
// Why this exists:
//   On Android WebView (and some desktop browsers), a controlled
//   <input value={state} onChange={e => setState(e.target.value)} />
//   loses Chinese / Japanese / Korean composition state when the parent
//   re-renders mid-composition. The flow is:
//     1. User taps pinyin keys → IME shows underlined preview ("composing")
//     2. WebView fires `input` event with composing text
//     3. React onChange fires → setState → re-render
//     4. React reconciles `value=...` back onto <input>
//     5. IME composition is interrupted, preview text vanishes
//   Symptom users see: "I type Chinese, text appears for ~1s, then disappears."
//
// What this fixes:
//   This wrapper tracks `compositionstart`/`compositionend` via a ref.
//   While composing, onChange is NOT propagated to the consumer, so React
//   state and the input's `value` stay frozen until composition commits.
//   On `compositionend`, we fire onChange exactly once with the final
//   committed text. English / numeric / paste paths are completely
//   unaffected (they never fire composition events).
//
// Usage:
//   `import { ComposableInput } from '../common/ComposableInput'`
//   then replace `<input ... />` 1:1 — props are identical to <input>.

import React, { useRef, forwardRef } from 'react';

export type ComposableInputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const ComposableInput = forwardRef<HTMLInputElement, ComposableInputProps>(
  function ComposableInput(
    { onChange, onCompositionStart, onCompositionEnd, ...rest },
    ref,
  ) {
    const isComposingRef = useRef(false);
    return (
      <input
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
          onChange?.(e as unknown as React.ChangeEvent<HTMLInputElement>);
        }}
      />
    );
  },
);
