import React from 'react';
import { ChevronDown, ChevronUp, Edit2, Key, UserCircle } from 'lucide-react';

interface AccountSectionProps {
  isOpen: boolean;
  onToggle: () => void;
  isDarkMode: boolean;
  sectionBorder: string;
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
  authUsername: string;
  authPassword: string;
  isEditing: boolean;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSave: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
}

export const AccountSection: React.FC<AccountSectionProps> = ({
  isOpen,
  onToggle,
  isDarkMode,
  sectionBorder,
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
  authUsername,
  authPassword,
  isEditing,
  onUsernameChange,
  onPasswordChange,
  onSave,
  onStartEdit,
  onCancelEdit
}) => {
  const innerCardClass = `p-3 rounded border ${isDarkMode ? 'bg-black/30 border-white/10' : 'bg-white border-gray-200'}`;

  return (
    <div className={`flex flex-col rounded-lg border overflow-hidden transition-all duration-300 flex-shrink-0 ${sectionBorder}`}>
      <button onClick={onToggle} className="flex items-center justify-between p-4 w-full">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-full ${isDarkMode ? 'bg-red-900/30 text-red-400' : 'bg-red-100 text-red-700'}`}>
            <Key size={20} />
          </div>
          <div className="text-left">
            <h3 className={`font-bold text-sm ${isDarkMode ? 'text-yellow-100' : 'text-gray-900'}`}>{title}</h3>
            {!isOpen && <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{desc}</p>}
          </div>
        </div>
        {isOpen ? <ChevronUp size={16} className="opacity-50" /> : <ChevronDown size={16} className="opacity-50" />}
      </button>

      {isOpen && (
        <div className="p-4 pt-0 animate-in slide-in-from-top-2 flex flex-col gap-4">
          <div className={innerCardClass}>
            <p className={`text-xs mb-3 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>{desc}</p>
            <h4 className={`text-xs font-bold mb-3 flex items-center gap-2 ${isDarkMode ? 'text-red-400' : 'text-red-600'}`}>
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
                  <button onClick={onSave} className="flex-1 py-2 bg-green-600 text-white font-bold text-xs rounded hover:bg-green-700">{saveLabel}</button>
                  <button onClick={onCancelEdit} className="flex-1 py-2 bg-gray-600 text-white font-bold text-xs rounded hover:bg-gray-700">{cancelLabel}</button>
                </div>
              ) : (
                <button onClick={onStartEdit} className={`mt-2 py-2 border border-dashed rounded text-xs font-bold flex items-center justify-center gap-2 ${isDarkMode ? 'border-gray-600 text-gray-400 hover:text-white' : 'border-gray-400 text-gray-600 hover:text-black'}`}>
                  <Edit2 size={12} /> {editLabel}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
