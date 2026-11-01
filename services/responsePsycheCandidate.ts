import type { ResponsePsycheDelta } from '../types';

// Parsing is deliberately pure: rewrites and discarded prewarms never mutate
// state. Clamp before handing a candidate to the eventual delivery owner.
export function parseResponsePsycheDelta(rawLog: string): ResponsePsycheDelta | undefined {
  const match = rawLog.match(/Psyche_Delta\s*[:\]=]\s*stress\s*([+-]?\d+)\s*,\s*energy\s*([+-]?\d+)\s*,\s*relaxation\s*([+-]?\d+)(?=\s*(?:\]|\||\n|$))/i);
  if (!match) return undefined;
  const values = match.slice(1).map(Number);
  if (!values.every(Number.isFinite)) return undefined;
  const [stress, energy, relaxation] = values.map(v => Math.max(-5, Math.min(5, v)));
  if (!stress && !energy && !relaxation) return undefined;
  return { stress, energy, relaxation };
}

export function createResponseEventId(): string {
  return `response-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`}`;
}
