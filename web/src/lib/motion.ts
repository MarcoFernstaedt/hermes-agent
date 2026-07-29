/**
 * The motion catalogue — the primitives behind Part 10's animations.
 *
 * These are the *visual* half of the motion system (the tokens in index.css are
 * the timing half). Imperator is meant to feel alive and expensive: cards
 * physically travel when a record advances, numbers count to their new value,
 * a row warms gold when something pushes an update, a card morphs into its
 * detail view. That richness is the point — accessibility is delivered by
 * making every one of these degrade to an instant, information-complete state
 * change, not by making the app austere.
 *
 * Everything here is pure and unit-tested; the DOM-touching wrappers live in
 * hooks that consume these.
 */

/** Durations, mirrored from the CSS tokens so JS-driven motion matches CSS. */
export const MOTION = {
  micro: 100,
  state: 160,
  move: 240,
  panel: 280,
  route: 260,
  /** Value counting is deliberately longer — it must be readable, not a blur. */
  count: 400,
  /** A live-update warm decays slowly enough to notice, fast enough to ignore. */
  warm: 800,
} as const;

/** The one spring curve, as an easing function for JS-driven interpolation. */
export function easeSpring(t: number): number {
  // Matches cubic-bezier(0.22, 1, 0.36, 1) closely enough for value animation.
  return 1 - Math.pow(1 - t, 3);
}

export function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 2);
}

/**
 * Entrance stagger. Batch arrivals cascade so the eye can follow them, but a
 * long stagger reads as *slow* — so it caps, and everything past the cap lands
 * together.
 */
export const STAGGER_STEP_MS = 30;
export const STAGGER_MAX_ITEMS = 6;

export function staggerDelay(index: number): number {
  return Math.min(index, STAGGER_MAX_ITEMS) * STAGGER_STEP_MS;
}

/**
 * Whether a value change is worth animating. Counting a number that moved by a
 * hair is noise; counting one that changed because the user *navigated* is a
 * lie. Callers pass `sameContext: false` when the change is a navigation.
 */
export function shouldAnimateValue(
  from: number,
  to: number,
  opts: { sameContext?: boolean; minDelta?: number } = {},
): boolean {
  const { sameContext = true, minDelta = 1 } = opts;
  if (!sameContext) return false;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  return Math.abs(to - from) >= minDelta;
}

/** The value shown at progress `t` (0..1) when counting `from` → `to`. */
export function countValue(from: number, to: number, t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return from + (to - from) * easeOut(clamped);
}

/**
 * FLIP: the delta that makes an element *appear* to still be at its old
 * position, so releasing it animates the element physically travelling to its
 * new one. This is what makes a card advancing a stage unmistakable.
 */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlipDelta {
  dx: number;
  dy: number;
  sx: number;
  sy: number;
}

export function flipDelta(first: Box, last: Box): FlipDelta {
  return {
    dx: first.x - last.x,
    dy: first.y - last.y,
    sx: last.width === 0 ? 1 : first.width / last.width,
    sy: last.height === 0 ? 1 : first.height / last.height,
  };
}

/** True when the delta is large enough to be worth animating at all. */
export function isFlipWorthAnimating(d: FlipDelta, threshold = 1): boolean {
  return (
    Math.abs(d.dx) >= threshold ||
    Math.abs(d.dy) >= threshold ||
    Math.abs(1 - d.sx) >= 0.01 ||
    Math.abs(1 - d.sy) >= 0.01
  );
}

export function flipTransform(d: FlipDelta): string {
  return `translate(${d.dx}px, ${d.dy}px) scale(${d.sx}, ${d.sy})`;
}

/**
 * Is motion suppressed? Honours both the OS preference and the in-app setting,
 * matching the two CSS paths, so JS-driven motion can't animate when CSS
 * motion is off. Safe in non-DOM contexts (SSR, tests).
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (document.documentElement.dataset.motion === "reduced") return true;
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}
