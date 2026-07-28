import { describe, expect, it } from "vitest";
import {
  MOTION,
  countValue,
  easeOut,
  easeSpring,
  flipDelta,
  flipTransform,
  isFlipWorthAnimating,
  shouldAnimateValue,
  staggerDelay,
  STAGGER_MAX_ITEMS,
  STAGGER_STEP_MS,
} from "./motion";

describe("easing", () => {
  it("is anchored at both ends", () => {
    for (const ease of [easeOut, easeSpring]) {
      expect(ease(0)).toBe(0);
      expect(ease(1)).toBe(1);
    }
  });

  it("eases out — most distance covered early", () => {
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
    expect(easeSpring(0.5)).toBeGreaterThan(0.5);
  });
});

describe("stagger", () => {
  it("cascades then caps, so a batch never reads as slow", () => {
    expect(staggerDelay(0)).toBe(0);
    expect(staggerDelay(3)).toBe(3 * STAGGER_STEP_MS);
    // Past the cap everything lands together.
    expect(staggerDelay(STAGGER_MAX_ITEMS + 20)).toBe(STAGGER_MAX_ITEMS * STAGGER_STEP_MS);
  });
});

describe("shouldAnimateValue", () => {
  it("animates a meaningful change in the same context", () => {
    expect(shouldAnimateValue(10, 25)).toBe(true);
  });

  it("never animates a change caused by navigation", () => {
    expect(shouldAnimateValue(0, 900, { sameContext: false })).toBe(false);
  });

  it("swaps instantly for a trivial delta", () => {
    expect(shouldAnimateValue(10, 10)).toBe(false);
    expect(shouldAnimateValue(10, 10.4, { minDelta: 1 })).toBe(false);
  });

  it("ignores non-finite values", () => {
    expect(shouldAnimateValue(NaN, 5)).toBe(false);
    expect(shouldAnimateValue(1, Infinity)).toBe(false);
  });
});

describe("countValue", () => {
  it("starts at from, ends exactly at to", () => {
    expect(countValue(0, 100, 0)).toBe(0);
    expect(countValue(0, 100, 1)).toBe(100);
  });

  it("clamps out-of-range progress", () => {
    expect(countValue(0, 100, -1)).toBe(0);
    expect(countValue(0, 100, 5)).toBe(100);
  });

  it("counts downward too", () => {
    expect(countValue(100, 0, 1)).toBe(0);
    expect(countValue(100, 0, 0.5)).toBeLessThan(100);
  });
});

describe("FLIP", () => {
  const first = { x: 0, y: 0, width: 100, height: 50 };

  it("computes the delta that holds an element at its old position", () => {
    const last = { x: 200, y: 80, width: 100, height: 50 };
    const d = flipDelta(first, last);
    expect(d.dx).toBe(-200);
    expect(d.dy).toBe(-80);
    expect(d.sx).toBe(1);
    expect(flipTransform(d)).toBe("translate(-200px, -80px) scale(1, 1)");
  });

  it("captures scale when the element resizes", () => {
    const d = flipDelta(first, { x: 0, y: 0, width: 200, height: 100 });
    expect(d.sx).toBe(0.5);
    expect(d.sy).toBe(0.5);
  });

  it("skips animation when nothing meaningfully moved", () => {
    expect(isFlipWorthAnimating(flipDelta(first, first))).toBe(false);
    expect(isFlipWorthAnimating(flipDelta(first, { ...first, x: 40 }))).toBe(true);
  });

  it("never divides by zero on a collapsed element", () => {
    const d = flipDelta(first, { x: 0, y: 0, width: 0, height: 0 });
    expect(Number.isFinite(d.sx)).toBe(true);
    expect(Number.isFinite(d.sy)).toBe(true);
  });
});

describe("MOTION durations", () => {
  it("sit inside their specified bands", () => {
    expect(MOTION.micro).toBeGreaterThanOrEqual(80);
    expect(MOTION.micro).toBeLessThanOrEqual(120);
    expect(MOTION.state).toBeGreaterThanOrEqual(120);
    expect(MOTION.state).toBeLessThanOrEqual(200);
    expect(MOTION.move).toBeGreaterThanOrEqual(200);
    expect(MOTION.move).toBeLessThanOrEqual(280);
    expect(MOTION.panel).toBeGreaterThanOrEqual(240);
    expect(MOTION.panel).toBeLessThanOrEqual(320);
    expect(MOTION.route).toBeGreaterThanOrEqual(240);
    expect(MOTION.route).toBeLessThanOrEqual(300);
  });
});
