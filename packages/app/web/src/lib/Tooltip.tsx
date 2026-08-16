import { useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';

/**
 * Hover label for icon-only controls.
 *
 * The native `title` attribute technically works, but it waits about a
 * second and renders in the OS style, which is too slow to answer "what is
 * this button?" while scanning a toolbar. This appears quickly and in the
 * app's own palette.
 *
 * Shown on focus as well as hover, so the label is reachable by keyboard,
 * and marked aria-hidden with the real name on the trigger's aria-label —
 * a screen reader should hear the name once, not twice.
 */

type Side = 'top' | 'bottom' | 'left' | 'right';

const SIDE_CLASS: Record<Side, string> = {
  top: 'bottom-full left-1/2 mb-2 -translate-x-1/2',
  bottom: 'top-full left-1/2 mt-2 -translate-x-1/2',
  left: 'right-full top-1/2 mr-2 -translate-y-1/2',
  right: 'left-full top-1/2 ml-2 -translate-y-1/2',
};

export function Tooltip({
  label,
  side = 'bottom',
  children,
}: {
  label: string;
  side?: Side;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A short delay stops labels flashing as the pointer crosses a row of
  // buttons on its way somewhere else.
  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), 250);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };

  return (
    <span
      className="relative inline-flex"
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={hide}
    >
      {children}
      <span
        role="tooltip"
        aria-hidden
        className={clsx(
          'pointer-events-none absolute z-50 whitespace-nowrap rounded-[8px] px-2 py-1',
          'bg-text text-[12px] font-medium text-bg shadow-[var(--shadow)]',
          'transition-opacity duration-100',
          SIDE_CLASS[side],
          open ? 'opacity-100' : 'opacity-0'
        )}
      >
        {label}
      </span>
    </span>
  );
}
