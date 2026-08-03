import { describe, expect, it, vi } from "vitest";

import { createPushToTalkController, type SpeechRecognitionPort } from "./speech-push-to-talk";

function fakeRecognition(): SpeechRecognitionPort {
  return {
    continuous: false,
    interimResults: true,
    lang: "",
    onstart: null,
    onend: null,
    onresult: null,
    onerror: null,
    start: vi.fn(),
    stop: vi.fn(),
    abort: vi.fn(),
  };
}

describe("push-to-talk speech controller", () => {
  it("starts only on press and stops on release", () => {
    const recognition = fakeRecognition();
    const states: string[] = [];
    const controller = createPushToTalkController(() => recognition, {
      onState: (state) => states.push(state),
      onText: vi.fn(),
      onStatus: vi.fn(),
      language: "en-US",
    });

    controller.press();
    controller.press();
    expect(recognition.start).toHaveBeenCalledOnce();
    expect(states).toEqual(["requesting"]);
    recognition.onstart?.();
    expect(states.at(-1)).toBe("listening");

    controller.release();
    expect(recognition.stop).toHaveBeenCalledOnce();
    expect(states.at(-1)).toBe("stopping");
    recognition.onend?.();
    expect(states.at(-1)).toBe("idle");
  });

  it("returns final transcripts and ignores interim speech", () => {
    const recognition = fakeRecognition();
    const onText = vi.fn();
    const controller = createPushToTalkController(() => recognition, {
      onState: vi.fn(), onText, onStatus: vi.fn(), language: "en-US",
    });
    controller.press();
    recognition.onresult?.({ results: [
      { 0: { transcript: "interim" }, isFinal: false },
      { 0: { transcript: "final words" }, isFinal: true },
    ] });
    expect(onText).toHaveBeenCalledOnce();
    expect(onText).toHaveBeenCalledWith("final words");
  });

  it("surfaces permission/provider errors and does not restart", () => {
    const recognition = fakeRecognition();
    const states: string[] = [];
    const statuses: string[] = [];
    const controller = createPushToTalkController(() => recognition, {
      onState: (state) => states.push(state),
      onText: vi.fn(),
      onStatus: (status) => statuses.push(status),
      language: "en-US",
    });
    controller.press();
    recognition.onerror?.({ error: "not-allowed" });
    recognition.onend?.();

    expect(states.at(-1)).toBe("error");
    expect(statuses.at(-1)).toMatch(/not-allowed.*still type/i);
    expect(recognition.start).toHaveBeenCalledOnce();
  });

  it("aborts and releases microphone state on cancel or unmount", () => {
    const recognition = fakeRecognition();
    const states: string[] = [];
    const controller = createPushToTalkController(() => recognition, {
      onState: (state) => states.push(state),
      onText: vi.fn(), onStatus: vi.fn(), language: "en-US",
    });
    controller.press();
    controller.cancel();
    expect(recognition.abort).toHaveBeenCalledOnce();
    expect(states.at(-1)).toBe("idle");
  });
});
