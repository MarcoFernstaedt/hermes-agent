/**
 * Microphone, camera, location and emergency: the rules, not the devices.
 *
 * The tests that matter most are the negative ones. A permission that quietly
 * outlives its session, a wake word that keeps listening after the dashboard
 * closes, or an emergency path that becomes armed once the config looks
 * complete would each be invisible in a UI review and obvious here.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAMERA_GRANT,
  DEFAULT_VOICE_MODE,
  type CameraState,
  type EmergencyConfig,
  type LocationState,
  type VoiceState,
  activePurpose,
  cameraGrantSurvives,
  cameraNeedsConfirmation,
  cameraStatusText,
  canActivateEmergency,
  collectsLocationHistory,
  emergencyCameraStatusText,
  emergencyMissingSteps,
  emergencyStatusText,
  locationExpired,
  locationStatusText,
  mayUploadAmbientAudio,
  microphoneIsLive,
  microphoneStatusText,
  shouldSpeakReply,
} from "./sensorConsent";

function voice(over: Partial<VoiceState> = {}): VoiceState {
  return {
    mode: "push_to_talk",
    dashboardOpen: true,
    wakeWordEnabledAt: null,
    capturing: false,
    ...over,
  };
}

function camera(over: Partial<CameraState> = {}): CameraState {
  return {
    grant: "ask_each_time",
    sessionGrantedAt: null,
    dashboardOpen: true,
    active: false,
    emergencyConfigured: false,
    emergencyApproved: false,
    ...over,
  };
}

describe("push-to-talk is the default", () => {
  it("is the declared default mode", () => {
    expect(DEFAULT_VOICE_MODE).toBe("push_to_talk");
  });

  it("does not listen between turns", () => {
    expect(microphoneIsLive(voice())).toBe(false);
  });

  it("listens only while held", () => {
    expect(microphoneIsLive(voice({ capturing: true }))).toBe(true);
  });
});

describe("wake word is explicit, visible, and bounded by the dashboard", () => {
  it("does nothing until Marco enables it", () => {
    expect(microphoneIsLive(voice({ mode: "wake_word" }))).toBe(false);
  });

  it("listens once enabled while the dashboard is open", () => {
    expect(
      microphoneIsLive(voice({ mode: "wake_word", wakeWordEnabledAt: 1 })),
    ).toBe(true);
  });

  it("stops when the dashboard closes, with no action from Marco", () => {
    // A wake word that survives the tab is an always-listening microphone by
    // another name.
    expect(
      microphoneIsLive(
        voice({ mode: "wake_word", wakeWordEnabledAt: 1, dashboardOpen: false }),
      ),
    ).toBe(false);
  });

  it("never uploads ambient audio", () => {
    expect(mayUploadAmbientAudio()).toBe(false);
  });

  it("says in words whether the microphone is live", () => {
    expect(microphoneStatusText(voice({ mode: "off" }))).toContain("Microphone off");
    expect(microphoneStatusText(voice({ capturing: true }))).toContain("Listening");
    expect(
      microphoneStatusText(voice({ mode: "wake_word", wakeWordEnabledAt: 1 })),
    ).toContain("Wake word active");
  });

  it("explains why the microphone is off when the dashboard is closed", () => {
    const text = microphoneStatusText(
      voice({ mode: "wake_word", wakeWordEnabledAt: 1, dashboardOpen: false }),
    );
    expect(text).toContain("pauses when the dashboard is closed");
  });
});

describe("spoken replies", () => {
  it("speaks a reply to a question that was asked aloud", () => {
    // Answering a spoken question in text only is a broken conversation.
    expect(shouldSpeakReply({ turnStartedByVoice: true, autoSpeakEnabled: false })).toBe(true);
  });

  it("stays quiet for a typed turn unless asked", () => {
    expect(shouldSpeakReply({ turnStartedByVoice: false, autoSpeakEnabled: false })).toBe(false);
  });

  it("speaks typed turns too when Marco turns that on", () => {
    expect(shouldSpeakReply({ turnStartedByVoice: false, autoSpeakEnabled: true })).toBe(true);
  });
});

describe("camera: ask-each-time by default", () => {
  it("is the declared default", () => {
    expect(DEFAULT_CAMERA_GRANT).toBe("ask_each_time");
  });

  it("asks every time by default", () => {
    expect(cameraNeedsConfirmation(camera())).toBe(true);
  });

  it("stops asking under a session grant", () => {
    expect(
      cameraNeedsConfirmation(camera({ grant: "session", sessionGrantedAt: 1 })),
    ).toBe(false);
  });

  it("asks again once the session ends", () => {
    // The grant dies with the session, not on a timer someone must remember.
    expect(
      cameraNeedsConfirmation(
        camera({ grant: "session", sessionGrantedAt: 1, dashboardOpen: false }),
      ),
    ).toBe(true);
    expect(
      cameraGrantSurvives(camera({ grant: "session", sessionGrantedAt: 1, dashboardOpen: false })),
    ).toBe(false);
  });

  it("asks when the camera is switched off entirely", () => {
    expect(cameraNeedsConfirmation(camera({ grant: "off" }))).toBe(true);
  });

  it("says in words whether the camera is on", () => {
    expect(cameraStatusText(camera({ active: true }))).toBe("Camera on");
    expect(cameraStatusText(camera())).toContain("ask each time");
    expect(cameraStatusText(camera({ grant: "off" }))).toContain("cannot use it");
  });
});

describe("emergency camera is a different capability, not a wider setting", () => {
  it("is unaffected by a session grant", () => {
    // Collapsing the two would make "take a photo while I'm cooking" and
    // "open the camera if you think I'm in trouble" the same click.
    const state = camera({ grant: "session", sessionGrantedAt: 1 });
    expect(state.emergencyConfigured).toBe(false);
    expect(emergencyCameraStatusText(state)).toContain("not configured");
  });

  it("distinguishes not-configured from configured-but-not-approved", () => {
    // One is a setup step; the other is a decision Marco has not made.
    expect(emergencyCameraStatusText(camera({ emergencyConfigured: true }))).toContain(
      "not approved",
    );
  });

  it("says it is inactive even when fully approved", () => {
    const text = emergencyCameraStatusText(
      camera({ emergencyConfigured: true, emergencyApproved: true }),
    );
    expect(text).toContain("inactive");
  });
});

function emergency(over: Partial<EmergencyConfig> = {}): EmergencyConfig {
  return {
    contactConfigured: false,
    triggerConditionsConfigured: false,
    verificationWindowSeconds: null,
    messageApproved: false,
    cameraApproved: false,
    locationApproved: false,
    cancellationPathConfigured: false,
    testModeOnly: true,
    ...over,
  };
}

const FULLY_CONFIGURED: EmergencyConfig = {
  contactConfigured: true,
  triggerConditionsConfigured: true,
  verificationWindowSeconds: 300,
  messageApproved: true,
  cameraApproved: true,
  locationApproved: true,
  cancellationPathConfigured: true,
  testModeOnly: false,
};

describe("emergency is inert in this build", () => {
  it("cannot fire when nothing is configured", () => {
    expect(canActivateEmergency(emergency())).toBe(false);
  });

  it("cannot fire when everything is configured and approved", () => {
    // The config is modelled; the trigger is not built. Completing the setup
    // must not accidentally arm it.
    expect(canActivateEmergency(FULLY_CONFIGURED)).toBe(false);
  });

  it("has no combination of inputs that arms it", () => {
    const keys = Object.keys(FULLY_CONFIGURED) as (keyof EmergencyConfig)[];
    for (let mask = 0; mask < 1 << keys.length; mask += 1) {
      const config = { ...emergency() };
      keys.forEach((key, index) => {
        if (mask & (1 << index)) {
          (config[key] as unknown) = FULLY_CONFIGURED[key];
        }
      });
      expect(canActivateEmergency(config)).toBe(false);
    }
  });

  it("lists what is still missing rather than saying only 'not ready'", () => {
    const missing = emergencyMissingSteps(emergency());
    expect(missing).toContain("an emergency contact");
    expect(missing).toContain("a way to cancel it");
  });

  it("says it is inactive even when the setup is complete", () => {
    const text = emergencyStatusText(FULLY_CONFIGURED);
    expect(text).toContain("inactive");
    expect(text).toContain("cannot decide on its own");
  });

  it("names the missing pieces when setup is incomplete", () => {
    expect(emergencyStatusText(emergency())).toContain("Still needed");
  });
});

describe("location: a purpose, a precision, and a short life", () => {
  const purposes = [
    { id: "nav", label: "Getting to an appointment", precision: "precise" as const, retentionMinutes: 60 },
    { id: "weather", label: "Local weather", precision: "coarse" as const, retentionMinutes: 15 },
  ];

  function location(over: Partial<LocationState> = {}): LocationState {
    return { enabledPurposeId: null, purposes, lastUsedAt: null, ...over };
  }

  it("is off until a purpose is chosen", () => {
    expect(activePurpose(location())).toBeNull();
    expect(locationStatusText(location())).toBe("Location off.");
  });

  it("allows precise location when a named workflow needs it", () => {
    expect(activePurpose(location({ enabledPurposeId: "nav" }))?.precision).toBe("precise");
  });

  it("states purpose, precision, retention and last use together", () => {
    const text = locationStatusText(
      location({ enabledPurposeId: "nav", lastUsedAt: Date.now() - 120_000 }),
      Date.now(),
    );
    expect(text).toContain("Getting to an appointment");
    expect(text).toContain("precise");
    expect(text).toContain("60 minutes");
    expect(text).toContain("2 minutes ago");
  });

  it("says when it has never been used", () => {
    expect(locationStatusText(location({ enabledPurposeId: "nav" }))).toContain("not used yet");
  });

  it("keeps no history merely because location is available", () => {
    expect(collectsLocationHistory()).toBe(false);
  });

  it("expires a fix once its purpose's retention is up", () => {
    const purpose = purposes[1]; // 15 minutes
    const now = Date.now();
    expect(locationExpired(purpose, now - 14 * 60_000, now)).toBe(false);
    expect(locationExpired(purpose, now - 16 * 60_000, now)).toBe(true);
  });

  it("gives a shorter-lived purpose a shorter retention", () => {
    expect(purposes[1].retentionMinutes).toBeLessThan(purposes[0].retentionMinutes);
  });
});
