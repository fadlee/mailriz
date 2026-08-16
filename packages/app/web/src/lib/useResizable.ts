import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A drag-to-resize width that survives reloads.
 *
 * Reading mail is a long-lived layout — how wide the list should be depends
 * on the screen and on the person, so the choice is remembered rather than
 * reset on every visit.
 *
 * Dragging sets a `cursor`/`user-select` lock on <body>, otherwise the
 * pointer flickers between resize and text cursors and the drag selects
 * text across the page.
 */
export function useResizable(
  storageKey: string,
  { initial, min, max }: { initial: number; min: number; max: number }
) {
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved >= min && saved <= max) return saved;
    } catch {}
    return initial;
  });

  const [dragging, setDragging] = useState(false);
  const origin = useRef({ x: 0, width: 0 });

  const clamp = useCallback((n: number) => Math.min(max, Math.max(min, n)), [min, max]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      origin.current = { x: e.clientX, width };
      setDragging(true);
    },
    [width]
  );

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: PointerEvent) => {
      setWidth(clamp(origin.current.width + (e.clientX - origin.current.x)));
    };
    const onUp = () => setDragging(false);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);

    const { style } = document.body;
    const previous = { cursor: style.cursor, select: style.userSelect };
    style.cursor = 'col-resize';
    style.userSelect = 'none';

    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      style.cursor = previous.cursor;
      style.userSelect = previous.select;
    };
  }, [dragging, clamp]);

  // Persist the settled width, not every frame of the drag.
  useEffect(() => {
    if (dragging) return;
    try {
      localStorage.setItem(storageKey, String(width));
    } catch {}
  }, [width, dragging, storageKey]);

  /** Keyboard-reachable: a divider nobody can move without a mouse is a trap. */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 48 : 16;
      if (e.key === 'ArrowLeft') setWidth((w) => clamp(w - step));
      else if (e.key === 'ArrowRight') setWidth((w) => clamp(w + step));
      else return;
      e.preventDefault();
    },
    [clamp]
  );

  return { width, dragging, min, max, onPointerDown, onKeyDown, reset: () => setWidth(initial) };
}
