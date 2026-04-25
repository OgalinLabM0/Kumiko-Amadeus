import type React from 'react';

export const KUMIKO_COMPOSITION_END_GRACE_MS = 80;

type CompositionStampedElement = HTMLElement & {
  _kumikoLastCompositionEndAt?: number;
};

export function stampCompositionEnd(target: EventTarget | null): void {
  if (typeof HTMLElement === 'undefined') return;
  if (target instanceof HTMLElement) {
    (target as CompositionStampedElement)._kumikoLastCompositionEndAt = Date.now();
  }
}

export function shouldIgnoreEnterDuringImeGrace(
  event: React.KeyboardEvent<Element>,
  graceMs = KUMIKO_COMPOSITION_END_GRACE_MS,
): boolean {
  if (event.nativeEvent.isComposing) return true;

  const target = event.currentTarget;
  if (typeof HTMLElement === 'undefined') return false;
  if (!(target instanceof HTMLElement)) return false;

  const lastCompositionEndAt = (target as CompositionStampedElement)._kumikoLastCompositionEndAt;
  return typeof lastCompositionEndAt === 'number' && Date.now() - lastCompositionEndAt < graceMs;
}
