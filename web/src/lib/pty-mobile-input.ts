const DELETE = "\x7f";

// How long (ms) after a mobile IME / replacement event we treat subsequent
// terminal input as a candidate line-replacement rather than a plain append.
// Exported so the ChatPage integration and tests share one tunable value.
export const MOBILE_REPLACEMENT_WINDOW_MS = 350;

function chars(text: string): string[] {
  return Array.from(text);
}

function removeLastChar(text: string): string {
  const c = chars(text);
  c.pop();
  return c.join("");
}

 
function isPlainText(data: string): boolean {
  // eslint-disable-next-line no-control-regex -- terminal data may contain control chars
  return !/[\x00-\x1f\x7f]/.test(data);
}

function lastWordMatch(line: string): RegExpMatchArray | null {
  return line.match(/^(.*?)(\S+)(\s*)$/u);
}

function collapseDuplicatedFinalWord(text: string, previousLine: string): string {
  const match = text.match(/^(.*?)(\S+)(\s+)(\S+)(\s*)$/u);
  if (!match) return text;

  const [, prefix, first, , second, trailing] = match;
  if (first.toLocaleLowerCase() !== second.toLocaleLowerCase()) return text;
  // Only collapse a duplication the tracked line already ended with — i.e.
  // Gboard re-emitted the final word. Requiring a >=2-char word avoids
  // eating legitimate single-letter reduplication ("a a", "i i") that a
  // user may genuinely type inside the replacement window.
  if (first.length < 2) return text;
  if (!previousLine.trimEnd().toLocaleLowerCase().endsWith(first.toLocaleLowerCase())) {
    return text;
  }
  return `${prefix}${first}${trailing}`;
}

function replacementLineForMobileInput(
  currentLine: string,
  incoming: string,
): string | null {
  if (!currentLine || currentLine.length < 2 || !incoming) return null;

  const currentLower = currentLine.toLocaleLowerCase();
  const incomingLower = incoming.toLocaleLowerCase();

  if (incomingLower.startsWith(currentLower)) {
    return collapseDuplicatedFinalWord(incoming, currentLine);
  }

  const word = lastWordMatch(currentLine);
  if (!word) return null;

  const [, prefix, last, trailing] = word;
  if (trailing) return null;

  const incomingFirst = incoming.trimStart().split(/\s+/u)[0] ?? "";
  if (
    incomingFirst &&
    incomingFirst.toLocaleLowerCase() === last.toLocaleLowerCase()
  ) {
    return `${prefix}${collapseDuplicatedFinalWord(incoming, currentLine)}`;
  }

  return null;
}

export function shouldTreatInputAsMobileReplacement(
  inputType: string | undefined,
  data: string | null | undefined,
  isMobileLike: boolean,
): boolean {
  if (
    inputType === "insertReplacementText" ||
    inputType === "insertFromComposition" ||
    inputType === "insertCompositionText"
  ) {
    return true;
  }
  return isMobileLike && inputType === "insertText" && (data?.length ?? 0) > 1;
}

export type PtyInputState =
  | { certainty: "known"; value: string }
  | { certainty: "unknown"; value: null };

export function knownPtyInput(value = ""): PtyInputState {
  return { certainty: "known", value };
}

export function unknownPtyInput(): PtyInputState {
  return { certainty: "unknown", value: null };
}

export function ptyInputStateForConnection(freshSession: boolean): PtyInputState {
  return freshSession ? knownPtyInput("") : unknownPtyInput();
}

export function trackPtyInput(current: PtyInputState, data: string): PtyInputState {
  let next = current;
  for (const ch of chars(data)) {
    if (ch === "\r" || ch === "\n" || ch === "\x15") {
      next = knownPtyInput("");
    } else if (ch === "\x1b") {
      next = unknownPtyInput();
    } else if (ch === DELETE || ch === "\b") {
      next = next.certainty === "known"
        ? knownPtyInput(removeLastChar(next.value))
        : unknownPtyInput();
    } else if (isPlainText(ch)) {
      next = next.certainty === "known"
        ? knownPtyInput(next.value + ch)
        : unknownPtyInput();
    } else {
      next = unknownPtyInput();
    }
  }
  return next;
}

export function updatePtyInputLine(currentLine: string, data: string): string | null {
  const next = trackPtyInput(knownPtyInput(currentLine), data);
  return next.certainty === "known" ? next.value : null;
}

export function normalizePtyMobileInput(
  data: string,
  currentLine: string,
  replacementActive: boolean,
): { data: string; nextLine: string | null; normalized: boolean } {
  if (replacementActive && isPlainText(data)) {
    const replacementLine = replacementLineForMobileInput(currentLine, data);
    if (replacementLine !== null) {
      return {
        data: DELETE.repeat(chars(currentLine).length) + replacementLine,
        nextLine: replacementLine,
        normalized: true,
      };
    }
  }

  return {
    data,
    nextLine: updatePtyInputLine(currentLine, data),
    normalized: false,
  };
}

export type PtyEnqueueResult = {
  delivery: "blocked" | "failed" | "unknown";
  input: PtyInputState;
  submitIntent: boolean;
  normalized: boolean;
};

/**
 * Production seam for xterm `onData` → WebSocket input enqueue.
 *
 * An open WebSocket proves only that enqueue can be attempted. It never proves
 * that the PTY or Hermes accepted, parsed, or submitted the bytes, so successful
 * `send()` calls intentionally return `delivery: "unknown"`.
 */
export function enqueuePtyOnData(options: {
  data: string;
  current: PtyInputState;
  replacementActive: boolean;
  socketOpen: boolean;
  blocked: boolean;
  send: (data: string) => void;
}): PtyEnqueueResult {
  const submitIntent = /[\r\n]/u.test(options.data);
  if (!options.socketOpen || options.blocked) {
    return {
      delivery: "blocked",
      input: options.current,
      submitIntent,
      normalized: false,
    };
  }

  let outbound = options.data;
  let normalized = false;
  if (options.current.certainty === "known") {
    const result = normalizePtyMobileInput(
      options.data,
      options.current.value,
      options.replacementActive,
    );
    outbound = result.data;
    normalized = result.normalized;
  }
  const input = trackPtyInput(options.current, outbound);
  try {
    options.send(outbound);
  } catch {
    return {
      delivery: "failed",
      input: unknownPtyInput(),
      submitIntent,
      normalized,
    };
  }
  return { delivery: "unknown", input, submitIntent, normalized };
}
