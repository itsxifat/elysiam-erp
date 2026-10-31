/**
 * Moving the call card (the owner, 2026-10-31: "the call tab is over the caller details tab it is
 * hiding the details and the tab is not drag to movable").
 *
 * The card keeps its place at the bottom of the screen and is moved from there by its handle:
 * dragged with a mouse or a finger, nudged with the arrow keys, put back with a double-click or
 * Home. It never leaves the window, and where it was left is remembered in this browser (a
 * convenience: anything unreadable starts it at its place again).
 *
 * Plain listeners on the two elements rather than React state, so a drag does not re-render the
 * card sixty times a second; React never writes the card's `translate`, so it survives the card's
 * own re-renders (its clock ticks every second).
 */

const STORAGE_KEY = 'elysium.phone-dock.offset';
const STEP = 24;
const MARGIN = 8;

interface Offset {
  readonly x: number;
  readonly y: number;
}

const HOME: Offset = { x: 0, y: 0 };

function remembered(): Offset {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return HOME;
    const parsed = JSON.parse(raw) as Partial<Offset>;
    return typeof parsed.x === 'number' && typeof parsed.y === 'number'
      ? { x: parsed.x, y: parsed.y }
      : HOME;
  } catch {
    return HOME;
  }
}

function remember(offset: Offset): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(offset));
  } catch {
    // A private window or blocked storage: the card simply starts at its place next time.
  }
}

/** Make `card` movable by `handle`. Returns the function that stops it. */
export function attachDockDrag(card: HTMLElement, handle: HTMLElement): () => void {
  let offset = remembered();
  let drag: { pointer: number; fromX: number; fromY: number; at: Offset } | null = null;

  /** Put the card at `next`, pulled back inside the window. */
  const place = (next: Offset) => {
    card.style.translate = `${String(next.x)}px ${String(next.y)}px`;
    const box = card.getBoundingClientRect();
    let { x, y } = next;
    if (box.left < MARGIN) x += MARGIN - box.left;
    else if (box.right > window.innerWidth - MARGIN) x -= box.right - (window.innerWidth - MARGIN);
    if (box.top < MARGIN) y += MARGIN - box.top;
    else if (box.bottom > window.innerHeight - MARGIN) {
      y -= box.bottom - (window.innerHeight - MARGIN);
    }
    card.style.translate = `${String(x)}px ${String(y)}px`;
    offset = { x, y };
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    handle.setPointerCapture(event.pointerId);
    drag = { pointer: event.pointerId, fromX: event.clientX, fromY: event.clientY, at: offset };
  };
  const onPointerMove = (event: PointerEvent) => {
    if (drag?.pointer !== event.pointerId) return;
    place({ x: drag.at.x + event.clientX - drag.fromX, y: drag.at.y + event.clientY - drag.fromY });
  };
  const onPointerEnd = () => {
    if (drag === null) return;
    drag = null;
    remember(offset);
  };
  const onDoubleClick = () => {
    place(HOME);
    remember(offset);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const moves: Readonly<Record<string, Offset>> = {
      ArrowLeft: { x: offset.x - STEP, y: offset.y },
      ArrowRight: { x: offset.x + STEP, y: offset.y },
      ArrowUp: { x: offset.x, y: offset.y - STEP },
      ArrowDown: { x: offset.x, y: offset.y + STEP },
      Home: HOME,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    place(next);
    remember(offset);
  };
  const onResize = () => place(offset);

  place(offset);
  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', onPointerEnd);
  handle.addEventListener('pointercancel', onPointerEnd);
  handle.addEventListener('dblclick', onDoubleClick);
  handle.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onResize);
  return () => {
    handle.removeEventListener('pointerdown', onPointerDown);
    handle.removeEventListener('pointermove', onPointerMove);
    handle.removeEventListener('pointerup', onPointerEnd);
    handle.removeEventListener('pointercancel', onPointerEnd);
    handle.removeEventListener('dblclick', onDoubleClick);
    handle.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', onResize);
  };
}
