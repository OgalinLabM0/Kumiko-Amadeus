import React from 'react';

interface SettingsToggleProps {
  checked: boolean;
  onClick: () => void;
  activeTrackClass: string;
  inactiveTrackClass: string;
  ariaLabel?: string;
}

export const SettingsToggle: React.FC<SettingsToggleProps> = ({
  checked,
  onClick,
  activeTrackClass,
  inactiveTrackClass,
  ariaLabel
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={checked}
      aria-label={ariaLabel}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center overflow-hidden rounded-full p-[3px] transition-all active:scale-95 flex-shrink-0 ${
        checked ? activeTrackClass : inactiveTrackClass
      }`}
    >
      <span
        className="pointer-events-none absolute left-[3px] top-[3px] h-[22px] w-[22px] rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,0.18)] transition-transform duration-200"
        style={{ transform: checked ? 'translateX(20px)' : 'translateX(0)' }}
      />
    </button>
  );
};
