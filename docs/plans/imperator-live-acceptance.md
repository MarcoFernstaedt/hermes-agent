# Live acceptance

Everything below runs against a real runtime on the owner's machine. It exists
because every review cycle so far has found defects that no test in this
repository could have found — the fixtures encoded the same assumptions as the
code, so they agreed with it and both were wrong together. The unit tests are
the floor; this is the check.

Nothing here sends mail without an explicit approval, and no step prints a
secret value.

## What this evidence is bound to

Branch `claude/imperator-dashboard-mobile-xw09ri`, ending at commit
`a0b1297b4d278b2ec61d6b59fb584bba89e18ec2`, tree
`3133a5489da55da20fbf57dca2f20e6eac858367`. That is the last *code* commit;
this document is committed on top of it, so the tree recorded above is the one
every claim below was verified against. If `git rev-parse HEAD~1` does not
match it, this document has drifted and should be regenerated rather than
trusted.

The five commits it covers, oldest first:

| commit | tree | what |
| --- | --- | --- |
| `b7f2b8cc3` | `57c1b4ae1` | idempotency settlement fencing; malformed provider responses are ambiguous |
| `ab1310a4e` | `ae54fc8f7` | the approval-to-capability chain; the full tier catalogue |
| `4e87ed696` | `395de3826` | vault undo hash contract |
| `633576265` | `2686ac9fe` | native reconnect, prompt idempotency, new-chat scoping |
| `a0b1297b4` | `3133a5489` | Now reads Progress; persisted override; ordered sections |

## What is NOT claimed

Stated plainly, because a "PASS" that quietly covers less than it appears to is
worse than a FAIL.

* **The tool gate is `observe`, not `enforce`.** `HERMES_TOOL_GATE_MODE`
  defaults to `observe`. The approval chain works end to end and has tests that
  exercise it through the real gateway transport, but no production traffic has
  run through it in `enforce`. Turning it on is a decision to make against live
  traffic with someone watching, not in a commit.
* **`HERMES_APPROVAL_INTEGRITY` is `observe`.** Unchanged.
* **Nothing here has been deployed, restarted, or run against live services.**
  No live credentials were used, no message was sent, no Gmail state was
  modified, and the shared venv was not touched.
* **The active gateway mapping was not altered.** It still points at
  `release/owner-main-4c21` @ `4c21fd39c98456b6f195901712fed83e90d77241`. The
  separate `release/owner-main-fab8` @ `fab8f79c9` worktree is clean and is not
  the active mapping. Reported, not changed.
* **A source-review PASS does not authorise deployment.**

## Corrections to earlier evidence

Two claims in the previous version of this document were wrong, and the code
they described has been corrected along with them.

**Voice.** Earlier evidence said no browser capture path existed.
`web/src/lib/use-dictation.ts` contains a complete one — `getUserMedia`,
`MediaRecorder`, and a POST to `/api/audio/transcribe` — wired into the chat
composer and used by `ChatBubbleFeed.tsx`. The microphone is opened per press
and its tracks stopped when the press ends; there is no always-listening mode
and no server-side device access. The capability adapter also checked
`faster_whisper` alone, so a machine transcribing perfectly well through Groq
or OpenAI was told to "install faster-whisper to enable push-to-talk". Six
providers are supported and the local model is only the default. The card now
states the fact an owner needs before pressing the button: whether the
recording leaves the machine.

**Camera and location.** These reported `configured: true` and offered "Start
it from the page when you want it". There is no `getUserMedia({ video })` and
no `navigator.geolocation` call anywhere in `web/src/`. What exists is
`web/src/lib/sensorConsent.ts`, a consent state model with nothing wired to it.
They now report not-configured and say so, and the test asserting otherwise has
been rewritten so that the day something does ask for the camera, it has to be
revisited rather than quietly staying green.

## 0. Preconditions

```
git rev-parse --abbrev-ref HEAD      # claude/imperator-dashboard-mobile-xw09ri
python -m pytest -q                  # via scripts/run_tests_parallel.py, see below
```

Canonical runner (per-file subprocess isolation — a plain `pytest tests/` gives
different results):

```
HERMES_TEST_PATHS=tests HERMES_TEST_WORKERS=4 python scripts/run_tests_parallel.py -q
```

Web gate:

```
cd web && npm run typecheck && npx vitest run && npm run build
```

`npm run typecheck` must resolve `tsconfig.app.json`. If it ever silently
passes again, confirm it is checking anything at all:

```
cd web && npx tsc -p tsconfig.app.json --noEmit --listFiles | grep -c ChatPage.tsx
```

Zero means the typecheck is checking nothing, whatever its exit code says.

---

## 1. Google auth: is it connected?

No send is needed to answer this, and the command never prints a token value.

```
python -m hermes_cli.google_auth_status status
```

| Reported state | What it means | What to do |
|---|---|---|
| `not_connected` | No token in the encrypted store. | Provision it (§2). |
| `incomplete` | A token is stored but has no refresh token or client credentials — it expires within the hour and cannot renew. | Re-export a full authorized-user token, then provision it. |
| `reauth_required` | Google rejected the refresh token (`invalid_grant`); the grant was revoked or expired. | Reconnect the account, then provision the new token with `--replace`. |
| `unreadable` | Ciphertext is present but will not decrypt with the current key. **The grant is fine; the key changed.** | Restore `HERMES_TOKEN_KEY` or `~/.hermes/token_store.key`. Do not re-authorise. |
| `usable` | Refresh token and client credentials present, account active. | Proceed. |

`access token: expired` alongside `usable` is normal — the access token lasts
an hour and the refresh path renews it.

`status` exits non-zero when the account is not usable, so it composes:

```
python -m hermes_cli.google_auth_status status && echo "ready for §4"
```

Machine-readable form, for a script: `status --json`.

---

## 2. Provisioning Google auth into the store

The encrypted store is the source of truth, under `google/default`.

```
# From the legacy plaintext location the Workspace skill wrote:
python -m hermes_cli.google_auth_status provision

# From an explicit file:
python -m hermes_cli.google_auth_status provision /path/to/token.json

# Replacing an existing entry (after a revocation):
python -m hermes_cli.google_auth_status provision /path/to/token.json --replace
```

The payload must be a Google **authorized-user** JSON carrying `refresh_token`,
`client_id` and `client_secret`. Anything else is refused rather than stored:
an account that reports "connected" and fails at the first send would discover
the problem at the worst possible moment.

It will not overwrite an existing entry without `--replace`. Importing sets the
account `active`, which is how a stale `reauth_required` flag is cleared.

---

## 3. Native chat

Native chat is off by default and read from `localStorage`, so it can be turned
on against a real gateway with no rebuild:

```js
localStorage.setItem("imperator.nativeChat", "on");   // then reload
```

### 3a. One session per page, and a refresh resumes it

With the gateway's RPC log visible, load `/chat` and then reload it.

- **First load:** exactly one `session.create`. No `session.resume` (there is
  nothing to resume yet).
- **Every reload after:** exactly one `session.resume`, and **zero**
  `session.create`.
- The durable id in `localStorage` under
  `imperator.nativeChat.session:<profile>` must be unchanged across the reload.

A `session.create` on reload means the durable id was not persisted or the
resume fell back — check the browser console for the resume error. Fallback is
supposed to happen only on RPC code `4007`.

Count worker subprocesses before and after five reloads. The count must not
grow. A growing count is the leaked slash-worker this transport exists to
remove.

### 3b. The composer actually sends

1. The composer is **enabled** once the session connects. (The failure this
   replaces: connected, composer permanently disabled, because readiness was
   gated on a PTY state machine frozen at `connecting`.)
2. Type a message and send it. A `prompt.submit` appears on the wire; the
   reply streams into the bubble feed.
3. Send a second message **while the agent is still working**. It must be
   accepted and shown as queued — and the wire text must be the message
   itself, **not** `/queue <message>`. The `/queue` prefix is the terminal's
   mechanism; natively the gateway queues a mid-turn submit on its own.
4. Press stop mid-turn. A `session.interrupt` goes out. No `\x03` anywhere.
5. Kill the gateway, type a message (the bubble stays "sending"), restart the
   gateway. The held message flushes when the session reports ready. It must
   not sit "sending" forever.

### 3c. Approvals and clarifies

1. Trigger a gated tool call. The card renders.
2. Choose **Deny**. The wire shows `approval.respond` with
   `choice: "deny"` — not a keystroke, not a digit.
3. Confirm the card resolves **only after** the response is acknowledged. Deny
   with the gateway stopped: the card must stay open, because the agent is
   still blocked.
4. Answer a clarify question. The wire shows `clarify.respond` carrying the
   `request_id` from the request — not a positional index.

### 3d. The sidebar opens no session of its own

While native chat is on, the model/tools panel must produce **no**
`session.create`. Its model badge and any credential warning are fed by
`session.info` from the page's own session.

---

## 4. `gmail_send`

### 4a. Nothing goes out unapproved

Ask the agent to send a test message to an address you control.

1. An approval card appears **before** any send.
2. The card shows: the resolved sender, **every** recipient by address, the
   subject, and the body (truncated only with an explicit "truncated" marker).
3. The card offers **Once** and **Deny** only. If it offers "Session" or
   "Always", the once-only path is not wired — stop and report it.
4. Deny it. Nothing is sent. Confirm in the target mailbox.
5. Ask for the *same* message again. A fresh card appears — a denial does not
   consume the idempotency claim, so this is a first attempt, not a duplicate.
6. Approve it. It sends once. The response says `"Sent. This cannot be undone."`

### 4b. The approval cannot become a standing grant

1. In the same session, ask for a **different** message. A new card appears.
   One approval must never cover a second message.
2. With `--yolo` enabled, ask for a send. The card **still** appears. `--yolo`
   skipping an irreversible send would make ALWAYS_APPROVAL identical to
   APPROVAL.
3. In a cron session (`HERMES_CRON_SESSION=1`) with
   `approvals.cron_mode: approve`, a send is **refused**, not auto-approved.

### 4c. Duplicates and retries

1. Approve the same message twice in a row. The second returns
   `duplicate_suppressed: true` and **no second card appears** — nothing is
   about to happen, so there is nothing to consent to.
2. Force a failure (disconnect the network mid-send). Reconnect and retry the
   identical message. It is approved again and sends, and the result carries
   `retry_after_failed_attempt: true` with the previous error. A failed send
   must not be banned for the 24-hour key TTL.

### 4d. The audit row carries no content

```
# In the audit log for the send: recipient *count*, subject, and a truncated
# fingerprint. No body text, no recipient addresses.
```

---

## 5. Undo

1. Perform a reversible agent action, then undo it. The journal entry moves
   `done → undoing → undone`.
2. Trigger undo twice concurrently (two tabs, or the card and the shortcut).
   The reversal runs **once**; the loser is told it is already in progress.
3. Kill the process mid-compensation. The entry sits `compensating`, and is
   visible in `in_flight()`. After the in-flight timeout (15 min by default),
   `needing_repair()` reports it as `reversal_unknown` — not as a success, and
   not silently absent.
4. Fail the verifier on an **inverse**. The status is `undo_failed`, not
   `compensation_failed`: an internal restore that failed must not send the
   owner looking at an external provider that was never involved.

---

## 6. The approval-to-capability chain

The part with no live-traffic evidence, and the reason the gate is still
`observe`. Run this against a real gateway session.

1. **A gated tool asks.** With `HERMES_TOOL_GATE_MODE=enforce` in a *scratch*
   session, call an ALWAYS_APPROVAL tool. An `approval.request` reaches the
   client and the agent thread blocks. Report the frame.
2. **Answering runs it, once.** Answer `once`. The handler runs exactly one
   time. Call the same tool again: a **second** card appears. One approval must
   not license a retry loop.
3. **Denying stops it before the handler.** Report that the handler was not
   entered — not that it returned an error.
4. **Silence is not consent.** Let a card time out. The call is refused.
5. **A standing grant does not reach the strictest tier.** Answer `session` for
   an APPROVAL-tier tool; the next call runs without a card. Do the same for an
   ALWAYS_APPROVAL tool; it asks again.
6. **The tier catalogue.** `python -c "from hermes_cli.module_permissions
   import registered_permissions as r; print(len(r()))"` — expect every loaded
   tool covered. The declared split is 57 auto / 32 approval / 15
   always-approval across the 104 tools this build loads. Read
   `hermes_cli/tool_tiers.py` and disagree with specific lines; each AUTO entry
   is a claim, and registering a tool can only ever relax it.
7. **`terminal` is APPROVAL, deliberately.** Confirm the dangerous-command gate
   still fires underneath it — the tier asks about the shell once, that gate
   asks about `rm -rf` every time.
8. **Then leave the gate in `observe`.** Do not flip the default.

---

## 7. Prompt idempotency

1. Send a prompt, kill the socket before the acknowledgement arrives, let the
   client reconnect and resend. **One** turn runs. The second response carries
   `duplicate: true`.
2. Send two genuinely different messages. Both run.
3. Make a submission fail (a busy subagent). Retry after it clears: the retry
   is a real submission, not a silent "queued, duplicate" that waits forever.

---

## 8. Reconnect and new chat

1. Open native chat, then drop the socket *after* it is working (kill the
   gateway, or disable wifi). A reconnect is attempted, bounded, and the status
   reads `reconnecting` rather than staying `ready`.
2. Exhaust the retries. Held messages stop showing as "sending".
3. Compose a message while the socket is down, then hit **New chat** before it
   reconnects. The held message is **dropped**, not delivered into the new
   conversation minutes later.

---

## 9. Now and Progress

1. With routines incomplete, Now states completion and the income gate in
   words, sourced from the Progress store — the numbers must match the Progress
   screen exactly.
2. Complete a routine in Progress. Now's count changes; the completed routine
   disappears from the ranking rather than appearing as done.
3. Write a "tomorrow" line in last night's reflection. Now shows it verbatim.
   Clear it: the line is absent, not an empty placeholder.
4. Press "Start with this instead", then reload. The override survives.
5. Wait for the day to roll over (or set the clock forward). The override is
   gone and Imperator's suggestion is back.
6. Answer the review item the override pointed at. The override stops
   suppressing the suggestion for what remains.

---

## 10. Vault undo conflict

1. Have the agent write a note. Edit that note in Obsidian. Undo. It is
   **refused**, the note keeps the Obsidian edit, and the entry stays offerable.
2. Force the undo. The older version is restored and what it overwrote is
   itself backed up.
3. Delete the backup a journal entry points at and undo: refused, note
   untouched.
4. Replace a backup's contents with different bytes and undo: refused as
   `backup_changed`, not silently restored.

---

## What to report back

For each numbered step: pass, or the observed behaviour with the RPC frames or
log lines that show it. Counts where the step asks for counts —
"looks right" is what let the earlier defects through.

Do not merge to `main`, deploy, restart production, change
`HERMES_APPROVAL_INTEGRITY` or `HERMES_TOOL_GATE_MODE` from `observe`, alter
the active gateway mapping, or run any of this against live credentials or a
live mailbox.
