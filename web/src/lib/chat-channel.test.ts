import { describe, expect, it } from "vitest";

import {
  eventChannelForPtyAttach,
  isPtyOwnershipReady,
  ptyOwnershipLockName,
  shouldWaitForExistingPtyLock,
} from "./chat-channel";

describe("eventChannelForPtyAttach", () => {
  it("keeps the semantic event channel aligned with a reattached PTY after reload", () => {
    const attachToken = "00112233445566778899aabbccddeeff";

    expect(eventChannelForPtyAttach(attachToken)).toBe(
      eventChannelForPtyAttach(attachToken),
    );
  });

  it("rotates the channel when a fresh PTY attach identity is minted", () => {
    expect(eventChannelForPtyAttach("first-attach-token")).not.toBe(
      eventChannelForPtyAttach("second-attach-token"),
    );
  });

  it("does not expose the PTY attach token in the channel name", () => {
    const attachToken = "private-browser-attach-token";
    const channel = eventChannelForPtyAttach(attachToken);

    expect(channel).toMatch(/^chat-[a-z0-9]+-[a-z0-9]+$/);
    expect(channel).not.toContain(attachToken);
  });
});

describe("PTY ownership locking", () => {
  it("derives an opaque lock name from the attach token", () => {
    const token = "private-browser-attach-token";
    const lockName = ptyOwnershipLockName(token);

    expect(lockName).toMatch(/^hermes\.pty\.owner\.chat-[a-z0-9]+-[a-z0-9]+$/);
    expect(lockName).not.toContain(token);
  });

  it("waits for the outgoing document only on a true reload", () => {
    expect(shouldWaitForExistingPtyLock("reload")).toBe(true);
    expect(shouldWaitForExistingPtyLock("navigate")).toBe(false);
    expect(shouldWaitForExistingPtyLock("back_forward")).toBe(false);
    expect(shouldWaitForExistingPtyLock(undefined)).toBe(false);
  });

  it("never bypasses readiness before the exact token owns its lock", () => {
    expect(isPtyOwnershipReady("token-a", null)).toBe(false);
    expect(isPtyOwnershipReady("token-a", "token-b")).toBe(false);
    expect(isPtyOwnershipReady("token-a", "token-a")).toBe(true);
  });
});
