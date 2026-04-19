// Image quality preset — controls how aggressively user-uploaded images are
// resampled before we persist them (P1 #36). The previous project-wide default
// was 1024×1024 / 200KB, which mangled small text, signs, handwritten notes,
// and other detail-heavy content and made Flash-class vision models misread.
// Giving users an explicit dial lets low-token-budget setups keep the tight
// preset while everyone else gets real legibility back.

export type ImageQualityPreset = 'original' | 'high' | 'standard' | 'compact';

export interface ImageQualityConfig {
  /** Infinity disables size-based resampling (the 'original' preset). */
  maxSizeMB: number;
  /** Infinity disables dimension-based resampling. */
  maxWidthOrHeight: number;
  /** JPEG quality in [0, 1]. */
  initialQuality: number;
}

export const IMAGE_QUALITY_PRESETS: Record<ImageQualityPreset, ImageQualityConfig> = {
  // No compression. User keeps the raw bytes they uploaded. Highest disk & token cost.
  original: {
    maxSizeMB: Infinity,
    maxWidthOrHeight: Infinity,
    initialQuality: 1.0,
  },
  // Default. Roughly matches what vision-capable models recommend (Claude/Gemini
  // "high detail" tier). Keeps 2K-class resolution at quality 90, ~2MB max.
  high: {
    maxSizeMB: 2,
    maxWidthOrHeight: 2048,
    initialQuality: 0.9,
  },
  standard: {
    maxSizeMB: 0.5,
    maxWidthOrHeight: 1536,
    initialQuality: 0.85,
  },
  // The pre-#36 behaviour — tightest disk footprint but visibly degraded.
  compact: {
    maxSizeMB: 0.2,
    maxWidthOrHeight: 1024,
    initialQuality: 0.8,
  },
};

export const DEFAULT_IMAGE_QUALITY_PRESET: ImageQualityPreset = 'high';

export const IMAGE_QUALITY_PRESET_ORDER: ImageQualityPreset[] = ['compact', 'standard', 'high', 'original'];
