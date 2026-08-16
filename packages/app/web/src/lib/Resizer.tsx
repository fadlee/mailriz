import clsx from 'clsx';

/**
 * The grab handle between two panes.
 *
 * The hit area is deliberately wider than the visible line — a 1px target is
 * hard to catch — and it only tints once you're on it or dragging, so the
 * layout stays quiet at rest.
 */
export function Resizer({
  onPointerDown,
  onKeyDown,
  dragging,
  label,
  width,
  min,
  max,
  at = 'lg',
}: {
  onPointerDown: (e: React.PointerEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  dragging: boolean;
  label: string;
  width: number;
  min: number;
  max: number;
  /** Breakpoint at which the panes it divides are actually side by side. */
  at?: 'lg' | 'xl';
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={clsx(
        'group relative z-10 hidden w-1 shrink-0 cursor-col-resize focus-visible:outline-none',
        at === 'xl' ? 'xl:block' : 'lg:block'
      )}
    >
      {/* Widened hit area, invisible. */}
      <span className="absolute inset-y-0 -left-1 -right-1" />
      <span
        className={clsx(
          'absolute inset-y-0 left-0 w-px transition-colors',
          dragging
            ? 'bg-accent'
            : 'bg-border group-hover:bg-accent/60 group-focus-visible:bg-accent'
        )}
      />
    </div>
  );
}
