import React from 'react';
import { ChevronDown, ChevronUp, Edit2, Key, RotateCcw, UserCircle } from 'lucide-react';
import { Collapse } from '../Collapse';

interface AccountSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  sectionBorder: string;
  innerCardClass: string;
  inputClass: string;
  labelClass: string;
  title: string;
  desc: string;
  changeUserPass: string;
  usernameLabel: string;
  passwordLabel: string;
  saveLabel: string;
  cancelLabel: string;
  editLabel: string;
  resetLabel: string;
  authUsername: string;
  authPassword: string;
  isEditing: boolean;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSave: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onResetToDefaults: () => void;
}

export const AccountSection: React.FC<AccountSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  sectionBorder,
  innerCardClass,
  inputClass,
  labelClass,
  title,
  desc,
  changeUserPass,
  usernameLabel,
  passwordLabel,
  saveLabel,
  cancelLabel,
  editLabel,
  resetLabel,
  authUsername,
  authPassword,
  isEditing,
  onUsernameChange,
  onPasswordChange,
  onSave,
  onStartEdit,
  onCancelEdit,
  onResetToDefaults
}) => {
  return (
    <div className={`flex flex-col rounded-[1.2rem] border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between px-4 py-[1.05rem] w-full">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border shrink-0 ${isDarkMode ? 'border-red-500/20 bg-red-900/20 text-red-300' : 'border-red-200 bg-red-50/90 text-red-700'}`}>
            <Key size={18} />
          </div>
          <div className="text-left">
            <h3 className={`ka-section-title ${isDarkMode ? 'text-[#f5ebdc]' : 'text-[#49301f]'}`}>{title}</h3>
            {!isOpen && <p className={`ka-section-desc ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{desc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} /> : <ChevronDown size={16} className={isDarkMode ? 'text-[#d9c1a4]/70' : 'text-[#9e7c51]/75'} />}
      </button>

      <Collapse isOpen={isOpen}>
        <div className="px-4 pb-4 pt-0 flex flex-col gap-4">
          <div className={innerCardClass}>
            <p className={`ka-section-desc mb-3 ${isDarkMode ? 'text-[#b69f87]' : 'text-[#8f7458]'}`}>{desc}</p>
            <h4 className={`ka-label mb-3 flex items-center gap-2 ${isDarkMode ? 'text-red-400' : 'text-red-600'}`}>
              <UserCircle size={12} /> {changeUserPass}
            </h4>
            <div className="flex flex-col gap-3">
              <div>
                <label className={labelClass}>{usernameLabel}</label>
                <input type="text" value={authUsername} onChange={(e) => onUsernameChange(e.target.value)} disabled={!isEditing} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>{passwordLabel}</label>
                <input type="text" value={authPassword} onChange={(e) => onPasswordChange(e.target.value)} disabled={!isEditing} className={inputClass} />
              </div>
              {isEditing ? (
                <div className="flex gap-2 mt-2">
                  <button onClick={onSave} className={`flex-1 py-2 rounded-xl ka-label transition-colors ${isDarkMode ? 'bg-[#d5a54a] text-[#24170b] hover:bg-[#e2b35a]' : 'bg-[#8a673a] text-white hover:bg-[#775631]'}`}>{saveLabel}</button>
                  <button onClick={onCancelEdit} className={`flex-1 py-2 rounded-xl ka-label transition-colors ${isDarkMode ? 'bg-white/10 text-[#eadfce] hover:bg-white/15' : 'bg-[#f3eee7] text-[#6c5440] hover:bg-[#ece4d9]'}`}>{cancelLabel}</button>
                </div>
              ) : (
                <div className="flex flex-col gap-2 mt-2">
                  <button onClick={onStartEdit} className={`py-2 border border-dashed rounded-xl ka-label flex items-center justify-center gap-2 ${isDarkMode ? 'border-[#6e5a44] text-[#c9b8a3] hover:text-white hover:border-[#b89361]' : 'border-[#d8ccbc] text-[#7a6247] hover:text-[#523c28] hover:border-[#c6ab7e]'}`}>
                    <Edit2 size={12} /> {editLabel}
                  </button>
                  <button
                    onClick={onResetToDefaults}
                    className={`py-1.5 rounded-xl ka-label flex items-center justify-center gap-2 text-[0.72rem] tracking-[0.08em] transition-colors ${
                      isDarkMode
                        ? 'text-[#9a7d5e] hover:text-[#d4a852]'
                        : 'text-[#a18566] hover:text-[#8a6122]'
                    }`}
                  >
                    <RotateCcw size={11} /> {resetLabel}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </Collapse>
    </div>
  );
};
