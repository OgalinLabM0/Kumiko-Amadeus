// v2.14.11 — IME-safe controlled <input> drop-in (deeper fix for v2.14.10).
//
// Why v2.14.10 wasn't enough:
//   v2.14.10 wrapped <input value=... onChange=...> with a composition
//   guard that suppressed the consumer's onChange callback while the IME
//   was actively composing. That stopped the *parent state* from
//   churning mid-composition, but it did NOT stop React from doing its
//   per-commit controlled-input enforcement: every commit, React's
//   ReactDOMInput.updateWrapper does the equivalent of
//
//     if (node.value !== String(props.value)) node.value = String(props.value);
//
//   So when *any* unrelated parent re-render commits while the user is
//   still typing pinyin (e.g. the 1-second `setTimeLeft` setInterval in
//   chatActions.ts that runs during voice listening, the 1-second
//   nowTick in TaskPanel, the 30-second reminder reconcile loop, the
//   service-worker auto-update poll, etc.), React slams the DOM value
//   back to whatever the parent's state is (usually `""`), wiping out
//   the in-progress Chinese candidate. That's the
//   "type for ~1 second, content disappears" symptom that survived
//   v2.14.10.
//
// What this version does:
//   We make the <input> *uncontrolled* at the React layer (defaultValue,
//   no `value` prop is passed to the DOM element), so React's
//   updateWrapper enforcement no longer runs at all. The parent's
//   `value` prop is mirrored to the DOM manually inside a useEffect that
//   short-circuits when isComposingRef is true. As soon as
//   compositionend fires, we re-fire onChange so the parent state
//   catches up to whatever the IME just committed; the next render then
//   sees DOM value == prop value and the sync useEffect no-ops.
//
//   To keep React's internal valueTracker (the shadow value React diffs
//   against to decide whether to fire `onChange`) in sync after a
//   programmatic write, we go through the native HTMLInputElement
//   prototype setter rather than `el.value = ...` — otherwise the next
//   user keystroke after a clear-on-send wouldn't fire onChange because
//   React would still believe the value hadn't changed.
//
// Usage stays drop-in: `<ComposableInput value={...} onChange={...} ... />`
// with the same props as <input>. English / numeric / paste paths are
// unaffected because they never fire compositionstart/end.

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

export const ComposableInput = forwardRef<HTMLInputElement, ComposableInputProps>(
  function ComposableInput(
    { onChange, onCompositionStart, onCompositionEnd, value, defaultValue, ...rest },
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
    });

    return (
      <input
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
          onChange?.(e as unknown as React.ChangeEvent<HTMLInputElement>);
        }}
      />
    );
  },
);
