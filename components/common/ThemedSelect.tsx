import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export interface ThemedSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface ThemedSelectGroup {
  label: string;
  options: ThemedSelectOption[];
}

export type ThemedSelectItem = ThemedSelectOption | ThemedSelectGroup;

export interface ThemedSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: ThemedSelectItem[];
  isDarkMode: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Class applied to the trigger button (typically `inputClass`). */
  className?: string;
  /** Class appended to the inner flex wrapper of the trigger. */
  triggerInnerClassName?: string;
  ariaLabel?: string;
  menuMaxHeight?: number;
  /** Optional explicit id for the trigger element. */
  id?: string;
}

const isGroup = (item: ThemedSelectItem): item is ThemedSelectGroup =>
  Object.prototype.hasOwnProperty.call(item, 'options');

const flattenOptions = (items: ThemedSelectItem[]): ThemedSelectOption[] => {
  const out: ThemedSelectOption[] = [];
  for (const it of items) {
    if (isGroup(it)) {
      for (const o of it.options) out.push(o);
    } else {
      out.push(it);
    }
  }
  return out;
};

interface MenuPosition {
  top: number;
  left: number;
  width: number;
  /** Whether the menu flipped upward (above the trigger). */
  flipped: boolean;
  maxHeight: number;
}

const MENU_MARGIN = 8;

export const ThemedSelect: React.FC<ThemedSelectProps> = ({
  value,
  onChange,
  options,
  isDarkMode,
  placeholder,
  disabled = false,
  className,
  triggerInnerClassName,
  ariaLabel,
  menuMaxHeight = 280,
  id,
}) => {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [highlight, setHighlight] = useState<number>(-1);
  const typeaheadRef = useRef<{ buffer: string; timer: number | null }>({
    buffer: '',
    timer: null,
  });
  const autoId = useId();
  const triggerId = id ?? `themed-select-${autoId}`;

  useEffect(() => {
    setMounted(true);
    return () => {
      setMounted(false);
      if (typeaheadRef.current.timer !== null) {
        window.clearTimeout(typeaheadRef.current.timer);
        typeaheadRef.current.timer = null;
      }
    };
  }, []);

  const flat = useMemo(() => flattenOptions(options), [options]);
  const enabledIndices = useMemo(
    () => flat.map((o, i) => (o.disabled ? -1 : i)).filter(i => i >= 0),
    [flat],
  );
  const selectedIndex = useMemo(
    () => flat.findIndex(o => o.value === value),
    [flat, value],
  );
  const selectedLabel = selectedIndex >= 0 ? flat[selectedIndex].label : '';

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const spaceBelow = viewportH - rect.bottom - MENU_MARGIN;
    const spaceAbove = rect.top - MENU_MARGIN;
    const desired = Math.min(menuMaxHeight, Math.max(spaceBelow, spaceAbove));
    const flipped = spaceBelow < Math.min(menuMaxHeight, 200) && spaceAbove > spaceBelow;
    const available = flipped ? spaceAbove : spaceBelow;
    const maxH = Math.max(140, Math.min(menuMaxHeight, available));
    setPosition({
      top: flipped ? rect.top - MENU_MARGIN : rect.bottom + MENU_MARGIN,
      left: rect.left,
      width: rect.width,
      flipped,
      maxHeight: maxH,
    });
  }, [menuMaxHeight]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => {
      updatePosition();
    };
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (menuRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setHighlight(selectedIndex >= 0 ? selectedIndex : enabledIndices[0] ?? -1);
  }, [open, selectedIndex, enabledIndices]);

  const commit = useCallback(
    (idx: number) => {
      const opt = flat[idx];
      if (!opt || opt.disabled) return;
      onChange(opt.value);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [flat, onChange],
  );

  const moveHighlight = useCallback(
    (delta: number) => {
      if (enabledIndices.length === 0) return;
      const currentEnabledPos = enabledIndices.indexOf(highlight);
      let nextPos: number;
      if (currentEnabledPos === -1) {
        nextPos = delta > 0 ? 0 : enabledIndices.length - 1;
      } else {
        nextPos =
          (currentEnabledPos + delta + enabledIndices.length) % enabledIndices.length;
      }
      setHighlight(enabledIndices[nextPos]);
    },
    [enabledIndices, highlight],
  );

  const typeahead = useCallback(
    (char: string) => {
      const ref = typeaheadRef.current;
      ref.buffer = (ref.buffer + char).toLowerCase();
      if (ref.timer !== null) window.clearTimeout(ref.timer);
      ref.timer = window.setTimeout(() => {
        ref.buffer = '';
        ref.timer = null;
      }, 700);
      const startIdx = enabledIndices.indexOf(highlight);
      const ordered = startIdx >= 0
        ? [...enabledIndices.slice(startIdx + 1), ...enabledIndices.slice(0, startIdx + 1)]
        : enabledIndices;
      const match = ordered.find(i => flat[i].label.toLowerCase().startsWith(ref.buffer));
      if (match !== undefined) setHighlight(match);
    },
    [enabledIndices, flat, highlight],
  );

  const onTriggerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) setOpen(true);
        else moveHighlight(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!open) setOpen(true);
        else if (highlight >= 0) commit(highlight);
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      } else if (e.key === 'Tab') {
        if (open) setOpen(false);
      } else if (e.key.length === 1 && /\S/.test(e.key)) {
        if (!open) setOpen(true);
        typeahead(e.key);
      }
    },
    [commit, disabled, highlight, moveHighlight, open, typeahead],
  );

  useEffect(() => {
    if (!open || highlight < 0) return;
    const el = menuRef.current?.querySelector<HTMLElement>(
      `[data-index="${highlight}"]`,
    );
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  const triggerBase =
    'ka-themed-select-trigger inline-flex w-full items-center justify-between gap-2 cursor-pointer select-none text-left';
  const triggerDisabled = disabled ? 'opacity-60 cursor-not-allowed' : '';
  const triggerClass = [
    className ?? '',
    triggerBase,
    triggerInnerClassName ?? '',
    triggerDisabled,
  ]
    .filter(Boolean)
    .join(' ');

  const menuClass = isDarkMode
    ? 'bg-[#241a12] border border-[#8c6a3c] shadow-[0_18px_48px_rgba(0,0,0,0.55)] text-[#f2e5cf]'
    : 'bg-white border border-[#e4dacd] shadow-[0_14px_36px_rgba(95,68,38,0.16)] text-[#3f2f22]';

  const groupLabelClass = isDarkMode
    ? 'text-[#b09170] bg-[#1d140d]/70'
    : 'text-[#8f7458] bg-[#f4ebdc]/60';

  let runningIndex = -1;

  const chevronColor = isDarkMode ? 'text-[#d8c4a6]' : 'text-[#7c6245]';
  const placeholderColor = isDarkMode ? 'text-[#8e7659]' : 'text-[#b8a38c]';

  return (
    <>
      <button
        type="button"
        id={triggerId}
        ref={triggerRef}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        role="combobox"
        aria-controls={open ? `${triggerId}-menu` : undefined}
        onClick={() => {
          if (disabled) return;
          setOpen(prev => !prev);
        }}
        onKeyDown={onTriggerKeyDown}
        className={triggerClass}
      >
        <span
          className={`flex-1 min-w-0 truncate ${
            selectedIndex < 0 ? placeholderColor : ''
          }`}
        >
          {selectedIndex >= 0 ? selectedLabel : placeholder ?? ''}
        </span>
        <ChevronDown
          size={14}
          className={`${chevronColor} shrink-0 transition-transform ${
            open ? 'rotate-180' : ''
          }`}
          aria-hidden="true"
        />
      </button>
      {mounted && open && position
        ? createPortal(
            <div
              ref={menuRef}
              id={`${triggerId}-menu`}
              role="listbox"
              aria-labelledby={triggerId}
              tabIndex={-1}
              style={{
                position: 'fixed',
                top: position.flipped ? undefined : position.top,
                bottom: position.flipped
                  ? window.innerHeight - position.top
                  : undefined,
                left: position.left,
                width: position.width,
                maxHeight: position.maxHeight,
                zIndex: 999998,
              }}
              className={`rounded-[0.85rem] overflow-hidden backdrop-blur-sm ${menuClass}`}
              onMouseDown={e => {
                e.preventDefault();
              }}
            >
              <div
                className="ka-soft-h-scroll overflow-y-auto py-1"
                style={{ maxHeight: position.maxHeight }}
                onMouseLeave={() => setHighlight(-1)}
              >
                {options.map((item, groupIdx) => {
                  if (isGroup(item)) {
                    return (
                      <div key={`g-${groupIdx}-${item.label}`}>
                        <div
                          className={`px-3 py-1 text-[11px] font-semibold uppercase tracking-wider ${groupLabelClass}`}
                        >
                          {item.label}
                        </div>
                        {item.options.map(opt => {
                          runningIndex += 1;
                          const idx = runningIndex;
                          return (
                            <OptionRow
                              key={`${idx}-${opt.value}`}
                              opt={opt}
                              idx={idx}
                              isSelected={opt.value === value}
                              isHighlighted={idx === highlight}
                              isDarkMode={isDarkMode}
                              onHover={() => setHighlight(idx)}
                              onCommit={() => commit(idx)}
                            />
                          );
                        })}
                      </div>
                    );
                  }
                  runningIndex += 1;
                  const idx = runningIndex;
                  return (
                    <OptionRow
                      key={`${idx}-${item.value}`}
                      opt={item}
                      idx={idx}
                      isSelected={item.value === value}
                      isHighlighted={idx === highlight}
                      isDarkMode={isDarkMode}
                      onHover={() => setHighlight(idx)}
                      onCommit={() => commit(idx)}
                    />
                  );
                })}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
};

interface OptionRowProps {
  opt: ThemedSelectOption;
  idx: number;
  isSelected: boolean;
  isHighlighted: boolean;
  isDarkMode: boolean;
  onHover: () => void;
  onCommit: () => void;
}

const OptionRow: React.FC<OptionRowProps> = ({
  opt,
  idx,
  isSelected,
  isHighlighted,
  isDarkMode,
  onHover,
  onCommit,
}) => {
  const base =
    'flex items-center gap-2 px-3 py-2 ka-value text-sm cursor-pointer transition-colors';
  const disabledCls = 'opacity-40 cursor-not-allowed';
  let stateCls = '';
  if (opt.disabled) {
    stateCls = disabledCls;
  } else if (isSelected) {
    stateCls = isDarkMode
      ? 'bg-[#54402d] text-[#ffd78a]'
      : 'bg-[#f4e5cc] text-[#6f4b22]';
  } else if (isHighlighted) {
    stateCls = isDarkMode
      ? 'bg-[#3a2a1a] text-[#fff6e4]'
      : 'bg-[#f5eee1] text-[#3f2f22]';
  } else {
    stateCls = isDarkMode ? 'text-[#f2e5cf]' : 'text-[#3f2f22]';
  }

  return (
    <div
      role="option"
      aria-selected={isSelected}
      aria-disabled={opt.disabled || undefined}
      data-index={idx}
      onMouseEnter={() => {
        if (!opt.disabled) onHover();
      }}
      onMouseUp={() => {
        if (!opt.disabled) onCommit();
      }}
      className={`${base} ${stateCls}`}
    >
      <span className="flex-1 min-w-0 truncate">{opt.label}</span>
      {isSelected ? (
        <Check size={14} className={isDarkMode ? 'text-[#ffd78a]' : 'text-[#6f4b22]'} />
      ) : null}
    </div>
  );
};
