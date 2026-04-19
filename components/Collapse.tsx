import React from 'react';

interface CollapseProps {
  isOpen: boolean;
  duration?: number;
  children: React.ReactNode;
}

const EASE_OUT = 'cubic-bezier(0.33, 1, 0.68, 1)';
const EASE_IN = 'cubic-bezier(0.32, 0, 0.67, 0)';

export const Collapse: React.FC<CollapseProps> = ({ isOpen, duration = 280, children }) => (
  <div style={{
    display: 'grid',
    gridTemplateRows: isOpen ? '1fr' : '0fr',
    opacity: isOpen ? 1 : 0,
    transition: `grid-template-rows ${duration}ms ${isOpen ? EASE_OUT : EASE_IN}, opacity ${Math.round(duration * 0.6)}ms ${isOpen ? EASE_OUT : EASE_IN}`,
    willChange: 'grid-template-rows, opacity',
  }}>
    <div style={{ overflow: 'hidden', minHeight: 0 }}>
      {children}
    </div>
  </div>
);
