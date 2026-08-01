# Live acceptance: native chat and `gmail_send`

Everything below runs against a real runtime on the owner's machine. It exists
because two review cycles found defects that no test in this repository could
have found — the fixtures encoded the same assumptions as the code, so they
agreed with it and both were wrong together. The unit tests are the floor; this
is the check.

Nothing here sends mail without an explicit approval, and no step prints a
secret value.

---

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

## What to report back

For each numbered step: pass, or the observed behaviour with the RPC frames or
log lines that show it. Counts where the step asks for counts —
"looks right" is what let three of these defects through.

Do not merge to `main`, deploy, restart production, or change
`HERMES_APPROVAL_INTEGRITY_MODE` from `observe`.
