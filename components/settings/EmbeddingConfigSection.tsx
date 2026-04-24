// components/settings/EmbeddingConfigSection.tsx
//
// A5.0: settings UI for picking the cloud embedding provider used by
// Android's RAG search. Five providers (OpenAI / Gemini / 智谱 GLM /
// 通义 / custom OpenAI-compatible). Mirrors the look-and-feel of
// InternetSearchSection / TtsConfigSection so the entire Settings panel
// stays visually consistent.
//
// Visibility:
//   - Capacitor native (Android): always shown — RAG depends on it.
//   - Electron / PWA: hidden — PC's local bge-m3 ONNX is the source of
//     truth there. We import this section unconditionally but render
//     nothing on non-Capacitor platforms (`if (!isCapacitorNative())
//     return null` at the top of the body).
//
// F2A.3b: form body extracted to ./CloudEmbeddingForm so AIConfigScreen
// can reuse the same fields without duplicating the 5-provider grid.
// This file is now just the Collapse-card shell + header + form mount.

import React from 'react';
import { Brain, ChevronDown, ChevronUp } from 'lucide-react';
import { Collapse } from '../Collapse';
import { isCapacitorNative } from '../../services/environment';
import { CloudEmbeddingForm } from './CloudEmbeddingForm';

interface EmbeddingConfigSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  language: 'zh' | 'en';
  sectionBorder: string;
  innerCardClass: string;
  inputClass: string;
  fieldLabelClass: string;
  helperClass: string;
}

export const EmbeddingConfigSection: React.FC<EmbeddingConfigSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  language,
  sectionBorder,
  innerCardClass,
  inputClass,
  fieldLabelClass,
  helperClass,
}) => {
  // Hide entirely on platforms where PC's bge-m3 ONNX is the embedding
  // backend (Electron + PWA). The early-return is BEFORE any other
  // hooks so the hook count stays stable across renders.
  if (!isCapacitorNative()) return null;

  const headerLabel = language === 'zh' ? '云端 Embedding' : 'Cloud Embedding';
  const headerSub = language === 'zh' ? 'Android RAG / 日记 / 心理状态使用' : 'Used by Android RAG / diary / psyche';

  return (
    <div className={`p-4 rounded-2xl border ${sectionBorder}`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <Brain size={16} className="shrink-0" />
          <div>
            <div className="ka-h6">{headerLabel}</div>
            <div className={`ka-micro opacity-70 mt-0.5 ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              {headerSub}
            </div>
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      <Collapse isOpen={isOpen}>
        <div className={`${innerCardClass} mt-3 p-4 rounded-[1.15rem]`}>
          <CloudEmbeddingForm
            language={language}
            isDarkMode={isDarkMode}
            inputClass={inputClass}
            fieldLabelClass={fieldLabelClass}
            helperClass={helperClass}
          />
        </div>
      </Collapse>
    </div>
  );
};

export default EmbeddingConfigSection;
