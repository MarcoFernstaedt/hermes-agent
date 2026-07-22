import { useCallback, useRef, useState } from "react";
import { api } from "@/lib/api";

/**
 * Push-to-talk dictation for the chat composer. Records mic audio with
 * MediaRecorder, sends it to the agent's transcription provider
 * (/api/audio/transcribe), and hands the text back to the caller — the
 * voice-to-text path for a voice-first workflow. Falls back gracefully
 * (`supported === false`) where MediaRecorder/getUserMedia are unavailable.
 */
export type DictationState = "idle" | "recording" | "transcribing";

export interface Dictation {
  state: DictationState;
  supported: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
}

const supported =
  typeof window !== "undefined" &&
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof window.MediaRecorder !== "undefined";

export function useDictation(onTranscript: (text: string) => void): Dictation {
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelledRef = useRef(false);

  const cleanup = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  };

  const start = useCallback(async () => {
    if (!supported || state !== "idle") return;
    setError(null);
    cancelledRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        cleanup();
        if (cancelledRef.current || !blob.size) {
          setState("idle");
          return;
        }
        setState("transcribing");
        try {
          const dataUrl = await blobToDataUrl(blob);
          const res = await api.transcribeAudio(dataUrl, blob.type);
          if (res.ok && res.transcript) onTranscript(res.transcript);
          else setError("No speech detected — try again.");
        } catch {
          setError("Transcription failed — check the connection.");
        } finally {
          setState("idle");
        }
      };
      recorder.start();
      setState("recording");
    } catch {
      setError("Microphone access was denied.");
      cleanup();
      setState("idle");
    }
  }, [onTranscript, state]);

  const stop = useCallback(() => {
    if (recorderRef.current && state === "recording") recorderRef.current.stop();
  }, [state]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    if (recorderRef.current && state === "recording") {
      recorderRef.current.stop();
    } else {
      cleanup();
      setState("idle");
    }
  }, [state]);

  return { state, supported, error, start, stop, cancel };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onloadend = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}
