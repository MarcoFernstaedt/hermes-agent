/**
 * Microphone, camera and location: what is on, who turned it on, and when it
 * stops.
 *
 * This is a state model, not an activation path. Nothing here opens a device.
 * It exists so the *rules* are one testable thing rather than assumptions
 * spread across three components, because the rules are the part that must not
 * drift:
 *
 * **Every sensor mode is off until Marco turns it on**, and expires by itself.
 * A permission that outlives the session it was granted in is a permission
 * nobody remembers granting.
 *
 * **Session camera and emergency camera are different capabilities.** Not one
 * switch with a wider setting — separate state, separate consent, separate
 * expiry. Collapsing them would make "let Imperator take a photo while I'm
 * cooking" and "let Imperator open the camera when it thinks I'm in trouble"
 * the same click.
 *
 * **Emergency is inert here.** It can be configured and it can be simulated,
 * and it cannot fire. `canActivateEmergency()` returns false for every input in
 * this build, and a test asserts there is no argument that makes it true.
 *
 * **Every state has words.** Colour alone cannot carry "your microphone is
 * live" for someone who cannot see it.
 */

// ── Voice ───────────────────────────────────────────────────────────────────

/**
 * `push_to_talk` is the default and always available. `wake_word` is opt-in,
 * and only meaningful while the dashboard is open — a wake word that survives
 * the tab is an always-listening microphone by another name.
 */
export type VoiceMode = "off" | "push_to_talk" | "wake_word";

export interface VoiceState {
  mode: VoiceMode;
  /** True only while the dashboard experience is actually open. */
  dashboardOpen: boolean;
  /** Marco enabled wake-word for this session. Never persisted across sessions. */
  wakeWordEnabledAt: number | null;
  /** True when a turn is being captured right now. */
  capturing: boolean;
}

export const DEFAULT_VOICE_MODE: VoiceMode = "push_to_talk";

/**
 * Is the microphone allowed to be listening at this instant?
 *
 * Push-to-talk listens only while held, so it is never "listening" between
 * turns. Wake-word listens continuously *within the open dashboard* and
 * nowhere else — closing the dashboard ends it without Marco doing anything.
 */
export function microphoneIsLive(state: VoiceState): boolean {
  if (state.mode === "off") return false;
  if (state.mode === "push_to_talk") return state.capturing;
  return state.dashboardOpen && state.wakeWordEnabledAt !== null;
}

/** The words shown and announced. Never a colour, never an icon alone. */
export function microphoneStatusText(state: VoiceState): string {
  if (state.mode === "off") return "Microphone off";
  if (state.mode === "push_to_talk") {
    return state.capturing ? "Listening — release to send" : "Microphone off. Hold to talk.";
  }
  if (!state.dashboardOpen) return "Microphone off. Wake word pauses when the dashboard is closed.";
  if (state.wakeWordEnabledAt === null) return "Microphone off. Wake word is not enabled.";
  return state.capturing ? "Listening" : "Wake word active — listening for your wake word";
}

/**
 * Whether ambient audio may leave the device.
 *
 * Always false. Wake-word detection is local or it does not happen; streaming
 * ambient audio to a server so a remote model can decide whether it was
 * addressed is a different product, and not this one.
 */
export function mayUploadAmbientAudio(): boolean {
  return false;
}

/**
 * Should this turn's reply be spoken aloud?
 *
 * True for anything the owner started by voice — answering a spoken question
 * in text only is a broken conversation — and otherwise only when they asked
 * for it. The spoken reply never replaces the text; both always exist.
 */
export function shouldSpeakReply(args: {
  turnStartedByVoice: boolean;
  autoSpeakEnabled: boolean;
}): boolean {
  return args.turnStartedByVoice || args.autoSpeakEnabled;
}

// ── Camera ──────────────────────────────────────────────────────────────────

/**
 * `ask_each_time` is the default. `session` is a standing grant for the open
 * dashboard only. `emergency` is a separate capability that is inert in this
 * build.
 */
export type CameraGrant = "off" | "ask_each_time" | "session";

export interface CameraState {
  grant: CameraGrant;
  /** When the session grant was given. Null when there is no session grant. */
  sessionGrantedAt: number | null;
  dashboardOpen: boolean;
  /** True while a frame is being captured or a live view is open. */
  active: boolean;
  /**
   * Emergency camera access, configured separately. Present so the UI can
   * report it truthfully; it grants nothing in this build.
   */
  emergencyConfigured: boolean;
  emergencyApproved: boolean;
}

export const DEFAULT_CAMERA_GRANT: CameraGrant = "ask_each_time";

/** Does a capture need a fresh confirmation right now? */
export function cameraNeedsConfirmation(state: CameraState): boolean {
  if (state.grant === "off") return true;
  if (state.grant === "session") {
    // The grant dies with the session, not on a timer someone has to remember.
    return !(state.dashboardOpen && state.sessionGrantedAt !== null);
  }
  return true;
}

/** A session grant ends when the dashboard does. Nothing carries it forward. */
export function cameraGrantSurvives(state: CameraState): boolean {
  return state.grant === "session" && state.dashboardOpen && state.sessionGrantedAt !== null;
}

export function cameraStatusText(state: CameraState): string {
  if (state.active) return "Camera on";
  if (state.grant === "off") return "Camera off. Imperator cannot use it.";
  if (cameraGrantSurvives(state)) {
    return "Camera off. Allowed for this session without asking again.";
  }
  return "Camera off. Imperator will ask each time.";
}

/**
 * Emergency camera state, in words.
 *
 * Four distinct states because they need four different actions, and because
 * "not configured" and "configured but not approved" must never look alike —
 * one is a setup step and the other is a decision Marco has not made.
 */
export function emergencyCameraStatusText(state: CameraState): string {
  if (!state.emergencyConfigured) return "Emergency camera access: not configured.";
  if (!state.emergencyApproved) return "Emergency camera access: configured, not approved.";
  return "Emergency camera access: approved, and inactive in this build.";
}

// ── Emergency ───────────────────────────────────────────────────────────────

export interface EmergencyConfig {
  contactConfigured: boolean;
  triggerConditionsConfigured: boolean;
  verificationWindowSeconds: number | null;
  messageApproved: boolean;
  cameraApproved: boolean;
  locationApproved: boolean;
  cancellationPathConfigured: boolean;
  testModeOnly: boolean;
}

/**
 * Whether emergency behaviour could fire. **Always false in this build.**
 *
 * Written as an explicit constant rather than an unfinished condition so that
 * completing the configuration cannot accidentally arm it — the config is
 * modelled, the trigger is not built, and the honest answer to "would this
 * fire?" is no, regardless of how complete the setup looks. A test asserts
 * that no combination of inputs returns true.
 */
export function canActivateEmergency(config: EmergencyConfig): boolean {
  // Deliberately read and deliberately ignored. The parameter documents what a
  // reviewed implementation would consult; returning `false` regardless is
  // what makes this build inert, and is easier to verify than a condition that
  // happens to be unsatisfiable today.
  void config;
  return false;
}

/** What still has to be decided before emergency behaviour could be reviewed. */
export function emergencyMissingSteps(config: EmergencyConfig): string[] {
  const missing: string[] = [];
  if (!config.contactConfigured) missing.push("an emergency contact");
  if (!config.triggerConditionsConfigured) missing.push("trigger conditions");
  if (config.verificationWindowSeconds === null) missing.push("a verification window");
  if (!config.messageApproved) missing.push("the exact message to send");
  if (!config.cancellationPathConfigured) missing.push("a way to cancel it");
  return missing;
}

export function emergencyStatusText(config: EmergencyConfig): string {
  const missing = emergencyMissingSteps(config);
  if (missing.length) {
    return `Emergency contact is not set up. Still needed: ${missing.join(", ")}.`;
  }
  // Complete and still inert — say so, rather than implying it is armed.
  return (
    "Emergency contact is configured, and inactive. Imperator cannot contact " +
    "anyone, and cannot decide on its own that there is an emergency."
  );
}

// ── Location ────────────────────────────────────────────────────────────────

export type LocationPrecision = "off" | "coarse" | "precise";

/**
 * Retention is per named purpose, and short. Location is collected because a
 * specific task needs it, not because it is available — so the purpose comes
 * with the shortest retention that still lets the task work.
 */
export interface LocationPurpose {
  id: string;
  /** What it is for, in Marco's terms. Required. */
  label: string;
  precision: Exclude<LocationPrecision, "off">;
  retentionMinutes: number;
}

export interface LocationState {
  enabledPurposeId: string | null;
  purposes: LocationPurpose[];
  lastUsedAt: number | null;
}

/** Never keeps a history: background tracking is not implemented at all. */
export function collectsLocationHistory(): boolean {
  return false;
}

export function activePurpose(state: LocationState): LocationPurpose | null {
  if (!state.enabledPurposeId) return null;
  return state.purposes.find((p) => p.id === state.enabledPurposeId) ?? null;
}

export function locationStatusText(state: LocationState, now = Date.now()): string {
  const purpose = activePurpose(state);
  if (!purpose) return "Location off.";
  const expiresIn = purpose.retentionMinutes;
  const used =
    state.lastUsedAt === null
      ? "not used yet"
      : `last used ${Math.max(0, Math.round((now - state.lastUsedAt) / 60000))} minutes ago`;
  return (
    `Location on for ${purpose.label}: ${purpose.precision}, ` +
    `kept ${expiresIn} minutes, ${used}.`
  );
}

/** Whether a stored fix is past its purpose's retention and must be dropped. */
export function locationExpired(
  purpose: LocationPurpose,
  capturedAt: number,
  now = Date.now(),
): boolean {
  return now - capturedAt >= purpose.retentionMinutes * 60_000;
}
