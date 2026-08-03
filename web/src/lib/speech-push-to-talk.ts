export type PushToTalkState = "idle" | "requesting" | "listening" | "stopping" | "error";

export interface SpeechResultPort {
  results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
}

export interface SpeechErrorPort {
  error?: string;
}

export interface SpeechRecognitionPort {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: SpeechResultPort) => void) | null;
  onerror: ((event: SpeechErrorPort) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface PushToTalkSink {
  language: string;
  onState(state: PushToTalkState): void;
  onText(text: string): void;
  onStatus(status: string): void;
}

export interface PushToTalkController {
  press(): void;
  release(): void;
  cancel(): void;
}

export function createPushToTalkController(
  createRecognition: () => SpeechRecognitionPort,
  sink: PushToTalkSink,
): PushToTalkController {
  let recognition: SpeechRecognitionPort | null = null;
  let held = false;
  let endedWithError = false;

  function press(): void {
    if (recognition || held) return;
    held = true;
    endedWithError = false;
    sink.onState("requesting");
    sink.onStatus("Requesting microphone access. Release Push to talk to stop.");
    try {
      const next = createRecognition();
      recognition = next;
      next.continuous = true;
      next.interimResults = false;
      next.lang = sink.language;
      next.onstart = () => {
        if (!held) {
          next.stop();
          return;
        }
        sink.onState("listening");
        sink.onStatus("Listening only while Push to talk is held.");
      };
      next.onresult = (event) => {
        const text = Array.from(event.results)
          .filter((result) => result.isFinal)
          .map((result) => result[0]?.transcript ?? "")
          .join(" ")
          .trim();
        if (text) sink.onText(text);
      };
      next.onerror = (event) => {
        endedWithError = true;
        held = false;
        recognition = null;
        sink.onState("error");
        sink.onStatus(`Speech recognition error: ${event.error || "unknown error"}. You can still type the request.`);
      };
      next.onend = () => {
        recognition = null;
        if (held) {
          held = false;
          sink.onState("error");
          sink.onStatus("Speech recognition stopped unexpectedly. You can still type the request.");
        } else if (!endedWithError) {
          sink.onState("idle");
          sink.onStatus("Dictation stopped. Review the request text before insertion.");
        }
      };
      next.start();
    } catch (error) {
      held = false;
      recognition = null;
      endedWithError = true;
      sink.onState("error");
      sink.onStatus(`Speech recognition could not start: ${error instanceof Error ? error.message : "unknown error"}. You can still type the request.`);
    }
  }

  function release(): void {
    if (!held) return;
    held = false;
    if (!recognition) return;
    sink.onState("stopping");
    sink.onStatus("Stopping dictation. Review the text before insertion.");
    recognition.stop();
  }

  function cancel(): void {
    held = false;
    endedWithError = false;
    const active = recognition;
    recognition = null;
    active?.abort();
    sink.onState("idle");
    sink.onStatus("Dictation stopped without retaining audio in Hermes.");
  }

  return { press, release, cancel };
}
