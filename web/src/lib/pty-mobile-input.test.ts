import { describe, expect, it } from "vitest";

import {
  enqueuePtyOnData,
  knownPtyInput,
  normalizePtyMobileInput,
  ptyInputStateForConnection,
  shouldTreatInputAsMobileReplacement,
  trackPtyInput,
  unknownPtyInput,
  updatePtyInputLine,
} from "./pty-mobile-input";

describe("shouldTreatInputAsMobileReplacement", () => {
  it("recognizes explicit browser replacement input", () => {
    expect(shouldTreatInputAsMobileReplacement("insertReplacementText", "Kain", false)).toBe(true);
    expect(shouldTreatInputAsMobileReplacement("insertFromComposition", "Kain", false)).toBe(true);
    expect(shouldTreatInputAsMobileReplacement("insertCompositionText", "Kain", false)).toBe(true);
  });

  it("treats multi-character mobile insertText as replacement-like", () => {
    expect(shouldTreatInputAsMobileReplacement("insertText", "Kain", true)).toBe(true);
    expect(shouldTreatInputAsMobileReplacement("insertText", "K", true)).toBe(false);
    expect(shouldTreatInputAsMobileReplacement("insertText", "Kain", false)).toBe(false);
  });
});

describe("normalizePtyMobileInput", () => {
  it("turns a Gboard full-line suggestion into a line replacement", () => {
    const result = normalizePtyMobileInput(
      "hello my name is Kain Kain",
      "hello my name is kain",
      true,
    );

    expect(result.normalized).toBe(true);
    expect(result.nextLine).toBe("hello my name is Kain");
    expect(result.data).toBe("\x7f".repeat("hello my name is kain".length) + "hello my name is Kain");
  });

  it("turns a Gboard last-word suggestion into a last-word replacement", () => {
    const result = normalizePtyMobileInput("Kain", "hello my name is kain", true);

    expect(result.normalized).toBe(true);
    expect(result.nextLine).toBe("hello my name is Kain");
    expect(result.data).toBe("\x7f".repeat("hello my name is kain".length) + "hello my name is Kain");
  });

  it("does not normalize ordinary appends when replacement is not active", () => {
    const result = normalizePtyMobileInput(
      "hello my name is Kain Kain",
      "hello my name is kain",
      false,
    );

    expect(result.normalized).toBe(false);
    expect(result.nextLine).toBe("hello my name is kainhello my name is Kain Kain");
  });

  it("does not normalize control input", () => {
    const result = normalizePtyMobileInput("\r", "hello", true);

    expect(result.normalized).toBe(false);
    expect(result.nextLine).toBe("");
    expect(result.data).toBe("\r");
  });

  it("does not collapse legitimate single-letter reduplication", () => {
    // "a a" is a plausible thing to type; the >=2-char guard keeps the
    // duplicate-final-word collapse from eating it inside the window.
    const result = normalizePtyMobileInput("a a", "a", true);

    expect(result.normalized).toBe(false);
    expect(result.data).toBe("a a");
  });
});

describe("conservative PTY input tracking", () => {
  it("treats same-PTY reconnect as unknown and only a fresh session as empty", () => {
    expect(ptyInputStateForConnection(false)).toEqual(unknownPtyInput());
    expect(ptyInputStateForConnection(true)).toEqual(knownPtyInput(""));
  });

  it("tracks printable text, delete, and an explicit line reset", () => {
    expect(updatePtyInputLine("", "abc")).toBe("abc");
    expect(updatePtyInputLine("abc", "\x7f")).toBe("ab");
    expect(updatePtyInputLine("abc", "\r")).toBe("");
    expect(trackPtyInput(knownPtyInput("abc"), "\r")).toEqual(knownPtyInput(""));
  });

  it("turns cursor and unknown control input into unknown, never empty", () => {
    expect(updatePtyInputLine("hello", "\x1b[D")).toBeNull();
    expect(trackPtyInput(knownPtyInput("hello"), "\x1b[D")).toEqual(unknownPtyInput());
    expect(trackPtyInput(knownPtyInput("hello"), "\x1b[H")).toEqual(unknownPtyInput());
    expect(trackPtyInput(knownPtyInput("hello"), "\x01")).toEqual(unknownPtyInput());
  });

  it("stays unknown after printable input until a definitive reset", () => {
    expect(trackPtyInput(unknownPtyInput(), "more")).toEqual(unknownPtyInput());
    expect(trackPtyInput(unknownPtyInput(), "\x7f")).toEqual(unknownPtyInput());
    expect(trackPtyInput(unknownPtyInput(), "\x15")).toEqual(knownPtyInput(""));
  });
});

describe("production PTY onData to WebSocket enqueue", () => {
  it("enqueues insertion bytes once without Enter but reports acceptance unknown", () => {
    const sent: string[] = [];
    const result = enqueuePtyOnData({
      data: "Review this context",
      current: knownPtyInput(""),
      replacementActive: false,
      socketOpen: true,
      blocked: false,
      send: (data: string) => sent.push(data),
    });

    expect(sent).toEqual(["Review this context"]);
    expect(sent[0]).not.toContain("\r");
    expect(sent[0]).not.toContain("\n");
    expect(result.delivery).toBe("unknown");
    expect(result.input).toEqual(knownPtyInput("Review this context"));
    expect(result.submitIntent).toBe(false);
  });

  it("preserves unknown tracking and blocks disconnected enqueue without retry", () => {
    const sent: string[] = [];
    const unknown = enqueuePtyOnData({
      data: "user text",
      current: unknownPtyInput(),
      replacementActive: false,
      socketOpen: true,
      blocked: false,
      send: (data: string) => sent.push(data),
    });
    const disconnected = enqueuePtyOnData({
      data: "draft",
      current: knownPtyInput(""),
      replacementActive: false,
      socketOpen: false,
      blocked: false,
      send: (data: string) => sent.push(data),
    });

    expect(unknown).toMatchObject({ delivery: "unknown", input: unknownPtyInput() });
    expect(disconnected.delivery).toBe("blocked");
    expect(sent).toEqual(["user text"]);
  });

  it("reports a queued submit as unknown and a thrown WebSocket enqueue as failed", () => {
    const submit = enqueuePtyOnData({
      data: "\r",
      current: knownPtyInput("draft"),
      replacementActive: false,
      socketOpen: true,
      blocked: false,
      send: () => undefined,
    });
    const failed = enqueuePtyOnData({
      data: "draft",
      current: knownPtyInput(""),
      replacementActive: false,
      socketOpen: true,
      blocked: false,
      send: () => { throw new Error("socket closed during enqueue"); },
    });

    expect(submit).toMatchObject({ delivery: "unknown", submitIntent: true });
    expect(failed).toMatchObject({ delivery: "failed", input: unknownPtyInput() });
  });
});
