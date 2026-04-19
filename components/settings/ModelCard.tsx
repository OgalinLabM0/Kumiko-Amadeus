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
  <div className={`p-3 rounded-lg border flex flex-col gap-2 transition-colors ${
    validationResult === true ? (isDarkMode ? 'bg-green-950/15 border-green-800/30' : 'bg-green-50/50 border-green-200/60') :
    validationResult === false ? (isDarkMode ? 'bg-red-950/15 border-red-800/30' : 'bg-red-50/50 border-red-200/60') :
    (isDarkMode ? 'bg-white/5 border-white/10 hover:bg-white/10' : 'bg-gray-50 border-gray-200 hover:bg-gray-100')
  }`}>
    <div className="flex items-center gap-2 mb-1">
      <div className={`p-1.5 rounded shrink-0 ${isDarkMode ? 'bg-teal-900/30 text-teal-400' : 'bg-teal-100 text-teal-700'}`}>
        <Icon size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <h4 className={`ka-section-title tracking-[0.02em] ${isDarkMode ? 'text-teal-300' : 'text-teal-700'}`}>{title}</h4>
        {desc && <p className={`ka-micro ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{desc}</p>}
      </div>
      {validationResult === true && <CheckCircle size={16} className="text-green-500 shrink-0" />}
      {validationResult === false && <AlertTriangle size={16} className="text-red-500 shrink-0" />}
    </div>
    <div className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={defaultModel}
        className={`${inputClass} pr-8`}
      />
      <button
        onClick={onReset}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 ka-micro px-1 opacity-50 hover:opacity-100"
        title="Reset to Recommended"
      >
        <RefreshCw size={12} />
      </button>
    </div>
  </div>
);
