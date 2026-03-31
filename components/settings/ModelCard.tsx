import React from 'react';
import { AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react';
import { AIConfig } from '../../types';

interface ModelCardProps {
  title: string;
  slotKey: keyof AIConfig;
  icon: any;
  desc: string;
  defaultModel: string;
  validationResult: boolean | null;
  value: string;
  onChange: (val: string) => void;
  onReset: () => void;
  t_local: any;
  isDarkMode: boolean;
  inputClass: string;
  labelClass: string;
}

export const ModelCard: React.FC<ModelCardProps> = ({
  title,
  icon: Icon,
  desc,
  defaultModel,
  validationResult,
  value,
  onChange,
  onReset,
  t_local,
  isDarkMode,
  inputClass
}) => (
  <div className={`p-3 rounded border flex flex-col gap-2 transition-colors ${isDarkMode ? 'bg-white/5 border-white/10 hover:bg-white/10' : 'bg-gray-50 border-gray-200 hover:bg-gray-100'}`}>
    <div className="flex items-center gap-2 mb-1">
      <div className={`p-1.5 rounded shrink-0 ${isDarkMode ? 'bg-teal-900/30 text-teal-400' : 'bg-teal-100 text-teal-700'}`}>
        <Icon size={16} />
      </div>
      <div className="min-w-0">
        <h4 className={`ka-section-title tracking-[0.02em] ${isDarkMode ? 'text-teal-300' : 'text-teal-700'}`}>{title}</h4>
        <p className={`ka-micro ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{desc}</p>
      </div>
    </div>
    <div className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={defaultModel}
        className={`${inputClass} pr-8`}
      />
      {validationResult === true && <span className="absolute right-8 top-1/2 -translate-y-1/2" title={t_local.modelAvailable}><CheckCircle size={14} className="text-green-500" /></span>}
      {validationResult === false && <span className="absolute right-8 top-1/2 -translate-y-1/2" title={t_local.modelUnavailable}><AlertTriangle size={14} className="text-red-500" /></span>}
      <button
        onClick={onReset}
        className="absolute right-1 top-1/2 -translate-y-1/2 ka-micro px-1 opacity-50 hover:opacity-100"
        title="Reset to Recommended"
      >
        <RefreshCw size={12} />
      </button>
    </div>
  </div>
);
