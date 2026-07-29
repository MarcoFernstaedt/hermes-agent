import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { auditA11y } from "@/lib/a11y-audit";
import { State } from "@/lib/itemState";
import { ItemCard, type ItemCardProps } from "./ItemCard";

function render(over: Partial<ItemCardProps> = {}): string {
  const props: ItemCardProps = {
    item: {
      id: "i1",
      state: State.AWAITING_DECISION,
      title: "Reply to Bob about the invoice",
      kind: "email",
      risk: "low",
      source: "gmail",
    },
    consequence: "Sends an email to bob@example.com from your account.",
    permanence: "irreversible",
    artifact: "Hi Bob,\n\nThanks for the invoice — paying today.\n\nMarco",
    onApprove: () => {},
    onDeny: () => {},
    onModify: () => {},
    onSnooze: () => {},
    ...over,
  };
  return renderToStaticMarkup(<ItemCard {...props} />);
}

describe("content order", () => {
  it("puts the consequence before any action button", () => {
    // The owner must never reach a button before reading what it does.
    const html = render();
    expect(html.indexOf("Sends an email")).toBeLessThan(html.indexOf("Approve</button>"));
  });

  it("shows the staged artifact in full rather than behind a disclosure", () => {
    const html = render();
    expect(html).toContain("Thanks for the invoice");
    // No <details> wrapping the thing they have to judge.
    expect(html).not.toContain("<details");
  });

  it("bounds the artifact instead of reserving maximum height", () => {
    // Reserving max height stabilises the footprint but leaves huge blank
    // regions on short items; a bounded scroll region does neither.
    expect(render()).toContain("max-h-64 overflow-y-auto");
  });
});

describe("permanence", () => {
  it("warns plainly when an action cannot be undone", () => {
    expect(render({ permanence: "irreversible" })).toContain("This cannot be undone.");
  });

  it("does not let a compensation read as a real undo", () => {
    const html = render({ permanence: "compensation" });
    expect(html).toContain("not guaranteed");
    expect(html).not.toContain("This can be undone.");
  });

  it("says so when reversibility is unknown", () => {
    expect(render({ permanence: "unknown" })).toContain("treat as permanent");
  });
});

describe("verdict facts", () => {
  it("shows the gate trigger, which the old card discarded", () => {
    const html = render({
      item: {
        id: "i1",
        state: State.AWAITING_DECISION,
        title: "Run a script",
        kind: "terminal",
        risk: "medium",
        source: "agent",
        payload: { verdict: "ESCALATE", description: "rm inside a script" },
      },
    });
    expect(html).toContain("ESCALATE");
    expect(html).toContain("rm inside a script");
  });

  it("renders no verdict block at all when there was no review", () => {
    // A placeholder invites the reader to assume a review happened.
    const html = render();
    expect(html).not.toContain("Verdict");
    expect(html).not.toContain("Why gated");
  });
});

describe("phase", () => {
  it("offers decisions only while one is open", () => {
    expect(render()).toContain("Approve</button>");
    expect(render({ item: { ...base(), state: State.EXECUTING } })).not.toContain("Approve</button>");
  });

  it("never shows an approved item as finished", () => {
    const html = render({ item: { ...base(), state: State.APPROVED } });
    expect(html).toContain("Approved — not started yet.");
    expect(html).not.toContain("Done.</p>");
  });

  it("marks a failed reversal as needing the owner", () => {
    const html = render({ item: { ...base(), state: State.COMPENSATION_FAILED } });
    expect(html).toContain("needs you");
    expect(html).toContain('data-phase="attention"');
  });

  it("hides the buttons while a decision is in flight", () => {
    expect(render({ busy: true })).not.toContain("Approve</button>");
  });

  it("surfaces the retry count so a silent second attempt is visible", () => {
    const html = render({ item: { ...base(), state: State.EXECUTING, attempt: 3 } });
    expect(html).toContain("attempt 3");
  });
});

describe("provenance", () => {
  it("offers to explain and tune the rule when one is wired", () => {
    expect(render({ onTuneRule: () => {} })).toContain("Why am I seeing this?");
    expect(render()).not.toContain("Why am I seeing this?");
  });
});

describe("accessibility", () => {
  it("passes the audit in its busiest state", () => {
    const html = render({
      item: {
        ...base(),
        risk: "high",
        summary: "Bob asked twice.",
        payload: { verdict: "APPROVE", description: "external send" },
      },
      onTuneRule: () => {},
    });
    expect(auditA11y(html)).toEqual([]);
  });

  it("labels the card by its own title", () => {
    expect(render()).toContain('aria-labelledby="item-i1-title"');
  });
});

function base() {
  return {
    id: "i1",
    state: State.AWAITING_DECISION,
    title: "Reply to Bob about the invoice",
    kind: "email",
    risk: "low",
    source: "gmail",
  };
}
