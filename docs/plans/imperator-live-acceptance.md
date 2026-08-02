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
`1009624d4ef4b841c01020e3f5c634c7305d9a2c`, tree `f869c0454b6f75fcf060374ea6c78333037380f1`. That is the last *code* commit; this
document is committed on top of it, so the tree recorded above is the one every
claim below was verified against. If `git rev-parse HEAD~1` does not match it,
this document has drifted and should be regenerated rather than trusted.

The commits this candidate adds over the previous FAIL-HOLD candidate
`0e52f3a8cff7d2d1d9fec8c0732c42e20242630f`, oldest first:

| commit | tree | what |
| --- | --- | --- |
| `5e8691e4e` | `6a17f2457` | per-call tier escalation; durable prompt idempotency; Gmail outcome classification; voice status truthfulness |
| `8b2aa9092` | `1d812449b` | the undo surface (RPC + `hermes undo`); content-keyed cache invalidation; the missing slash-command import |
| `b00c133b4` | `86d000cbf` | the approval fixtures, updated to the id-and-actor contract the gateway now enforces |
| `1009624d4` | `f869c0454` | `observe` measures without asking — a card whose answer is discarded is worse than no card |
| _(this one)_ | | the undo screen: `/api/undo` endpoints, an Undo page, and the view logic they share |

**These commits are unsigned.** `commit.gpgsign` is on and `user.signingkey`
points at `/home/claude/.ssh/commit_signing_key.pub`, which is a zero-byte file
with no matching private key anywhere in the container, so git produces an
unsigned commit without complaining. Every commit already on this branch is in
the same state, including `0e52f3a8c` — the candidate the last review examined
— so this is the container's condition rather than a change made here. Signing
needs the key material provisioned; it cannot be fixed from inside a commit.

## The three kinds of evidence below

Kept apart on purpose, because a "PASS" that quietly mixes them is worse than a
FAIL.

**Executed here.** Source changes and test runs performed in this container,
with counts. Section A.

**Pending live acceptance.** Behaviour that can only be judged against a real
runtime with a person watching. Sections 1–11. Nothing in them has been run.

**Not executed, and why.** Checks that need a deployment, a live credential, or
a live mailbox. Section B. None of these were performed and none are claimed.

---

## A. Executed here — source and tests

Run in this container, against a temporary `HERMES_HOME`, with no live
credentials, no network calls to a provider, and no deployment.

### A1. The commands, and their results

| command | result |
| --- | --- |
| `HERMES_TEST_PATHS=tests HERMES_TEST_WORKERS=8 python scripts/run_tests_parallel.py -q` | **2183 files, 44923 passed, 0 failed** in 1400.6s (8 workers) |
| `npm run typecheck --workspace web` | **pass** — `tsconfig.app.json` and `tsconfig.node.json`, no errors |
| `npm test --workspace web -- --run` | **75 files, 766 passed, 0 failed** |
| `npm run lint --workspace web` | **pass** — eslint, no findings |
| `npm run build --workspace web` | **pass** |
| `npm test` | **not runnable** — the repo root defines no `test` script (`npm error Missing script: "test"`). The workspace suites are covered by the `npm test --workspace web` row above. |
| `npm run check` | **fails, pre-existing** — 5 TypeScript errors in `apps/bootstrap-installer` because `@tauri-apps/api` is declared in its `package.json` and not installed in this container. Verified identical at the failed candidate `0e52f3a8c`, so it is environmental and not caused by this work. |

The Python runner is the canonical one: it isolates each file in its own
subprocess, and a plain `pytest tests/` gives different results because
module-level state leaks between files.

### A2. What the source changes are, per FAIL-HOLD blocker

**Approval and capability integrity.** A tier classifies a tool *name*, and
three tools in the catalogue answer to a name covering two different actions:
`browser_console` reads the console log or evaluates arbitrary JavaScript in
the page origin; `text_to_speech` speaks locally or writes a caller-chosen file
or uploads the text to an API; `terminal` runs `git status` or `curl | sh`.
Left alone each is a standing grant on the safe form silently covering the
dangerous one. `module_permissions` gained per-call escalation: a rule attached
to a tool name may raise the tier for one call from its arguments and can never
lower one; a rule that raises escalates to ALWAYS_APPROVAL rather than passing.
Escalated calls are minted `once_only`, so no session cache, `--yolo`, or
permanent entry can cover them. Every consumer that asked the name-level
question now asks the call-level one: the dispatch gate, the integrity snapshot
in `model_tools`, the agent scopes, and the pre-dispatch guards.

**Prompt idempotency.** The token table evicted its oldest entry under pressure
— frequently a long turn still running — and lived in the live session dict, so
an orphan reap, restart or cold resume erased every record. That is exactly the
window in which a client resends. `tui_gateway/submit_ledger.py` keeps the
cache in front of the durable idempotency store, keyed by the persistent
session key; only settled entries are evictable, and a session holding too many
live claims refuses a submission rather than forgetting one. A new
`prompt.reconcile` RPC lets a client ask before resending, and only "never
seen" counts as permission.

**Gmail.** `str(result.get("id") or "")` accepted a dict, a bool or an int as a
confirmed send. Only a string of plausible Gmail shape is accepted now.
Reconciliation treated an empty Sent-folder search as proof of non-delivery and
made the message sendable again; the index lags a send and a throttled query
returns nothing, so a negative search now leaves the row ambiguous and clearing
it requires attributed proof. `_safe_error` bounded its excerpt but did not
redact it, and a 550 rejection quotes the recipient and subject inside the
first sixty characters; it now scrubs sender, recipients and subject by value.

**Voice.** The status card re-derived transcription state from environment
variables while the runtime resolved it from config. Both halves now resolve
through the functions the runtime calls, on the same config, with
`allow_install=False` so rendering a card cannot install a package. Local,
remote and undetermined are distinguished; a command or plugin provider is
reported as undetermined rather than local.

**Undo.** The journal had no production reader. `hermes_cli/undo/surface.py` is
the one place that renders entries and applies decisions; the gateway's
`undo.list`/`undo.preview`/`undo.apply`, the `hermes undo` command, and the
`/api/undo` routes behind the dashboard's Undo page are all thin over it. A refusal (nothing attempted, entry still offerable) and a
failure (ran, did not take, entry needs a person) are different answers.

**Qualification defects.** `gateway/slash_commands.py` called
`resolve_oldest_gateway_approval` without importing it, so every plain-text and
slash approval raised NameError and fell through to busy handling. Cache
invalidation keyed on `(mtime_ns, size)` now keys on content, and the
bundled-skills fingerprint covers the tree rather than one directory's `stat`.
The update test's frontend assertion no longer depends on whether the working
tree has a freshly built `web_dist`.

### A3. Adversarial tests added

Each asserts the handler or the external call happened **zero** times. A gate
that refuses after the side effect is not a gate.

| file | what it holds |
| --- | --- |
| `tests/hermes_cli/test_per_call_tier_escalation.py` | escalation can only raise; a rule that raises escalates; trusting a tool does not cover its dangerous form; a read-only scope stays read-only |
| `tests/tools/test_dispatch_capability_gate.py` | missing/invalid gate mode never reaches a handler; a call with no correlation id is refused; a capability from another session or another call is refused |
| `tests/tools/test_approval_to_capability_chain.py` | a response with no approver identity refuses; an approval that cannot be audited refuses and the grant is revoked |
| `tests/test_tui_gateway_submit_idempotency.py` | an in-flight claim is never evicted; a flood of live claims is refused; claims and outcomes survive a cold resume; a failed lookup never says "resend" |
| `tests/tools/test_gmail_send.py` | a stale negative Sent search stays ambiguous; malformed provider ids (dict, list, int, bool, short string) are not confirmations; durable state carries no message content |
| `tests/hermes_cli/test_voice_status_truthfulness.py` | disabled STT reports disabled; an explicit provider is not replaced by the local model; a remote provider is never reported as local; the card installs nothing |
| `tests/hermes_cli/test_undo_surface.py` | conflict reported not decided; forcing is a separate call; a failed reversal reaches the repair list; an abandoned reversal is reconciled into view |
| `tests/hermes_cli/test_cache_invalidation_determinism.py` | a same-size same-timestamp rewrite is seen; a skill added inside an existing category is seen |

### A4. Worktree and credential residue

| check | result |
| --- | --- |
| `git status --porcelain` after the final commit | clean (0 entries) |
| `~/.qwen/oauth_creds.json` created during the run | no — `~/.qwen` does not exist |
| live credentials used | none |
| messages or email sent | none |
| services deployed or restarted | none |
| `HERMES_TOOL_GATE_MODE` / `HERMES_APPROVAL_INTEGRITY` changed from `observe` | no |

---

## B. Not executed here, and why

Stated plainly, because a "PASS" that quietly covers less than it appears to is
worse than a FAIL.

* **The tool gate is `observe`, not `enforce`.** `hermes_constants` now states
  the shipped default explicitly at startup rather than letting an unset
  variable resolve to the weakest setting — but the default is still `observe`,
  and no production traffic has run through the chain in `enforce`. Turning it
  on is a decision to make against live traffic with someone watching, not in a
  commit.
* **`HERMES_APPROVAL_INTEGRITY` is `observe`.** Unchanged.
* **Nothing here has been deployed, restarted, or run against live services.**
  No live credentials were used, no message was sent, no Gmail state was
  modified, and the shared venv was not touched.
* **The active gateway mapping was not altered.** It still points at
  `release/owner-main-4c21` @ `4c21fd39c98456b6f195901712fed83e90d77241`. The
  separate `release/owner-main-fab8` @ `fab8f79c9` worktree is clean and is not
  the active mapping. Reported, not changed.
* **A source-review PASS does not authorise deployment.**

---

## 0. Preconditions

```
git rev-parse --abbrev-ref HEAD      # claude/imperator-dashboard-mobile-xw09ri
```

Canonical runner (per-file subprocess isolation — a plain `pytest tests/` gives
different results):

```
HERMES_TEST_PATHS=tests HERMES_TEST_WORKERS=8 python scripts/run_tests_parallel.py -q
```

Web gate:

```
npm run typecheck --workspace web
npm test --workspace web -- --run
npm run lint --workspace web
npm run build --workspace web
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

1. The composer is **enabled** once the session connects.
2. Type a message and send it. A `prompt.submit` appears on the wire; the
   reply streams into the bubble feed.
3. Send a second message **while the agent is still working**. It must be
   accepted and shown as queued — and the wire text must be the message
   itself, **not** `/queue <message>`.
4. Press stop mid-turn. A `session.interrupt` goes out. No `\x03` anywhere.
5. Kill the gateway, type a message (the bubble stays "sending"), restart the
   gateway. The held message flushes when the session reports ready. It must
   not sit "sending" forever.

### 3c. Approvals and clarifies

1. Trigger a gated tool call. The card renders.
2. Choose **Deny**. The wire shows `approval.respond` with `choice: "deny"` and
   an `approval_id` — **not** a bare choice. A respond without an
   `approval_id` must be rejected with error `4020`.
3. Confirm the card resolves **only after** the response is acknowledged. Deny
   with the gateway stopped: the card must stay open, because the agent is
   still blocked.
4. With two cards pending at once, approve one by id. Only that one resolves.
   A bulk *approve* must be rejected with error `4019`; a bulk *deny* is
   allowed and resolves both.
5. Answer a clarify question. The wire shows `clarify.respond` carrying the
   `request_id` from the request — not a positional index.

### 3d. The sidebar opens no session of its own

While native chat is on, the model/tools panel must produce **no**
`session.create`.

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
2. With `--yolo` enabled, ask for a send. The card **still** appears.
3. In a cron session (`HERMES_CRON_SESSION=1`) with
   `approvals.cron_mode: approve`, a send is **refused**, not auto-approved.

### 4c. Duplicates, retries, and the ambiguous case

1. Approve the same message twice in a row. The second returns
   `duplicate_suppressed: true` and **no second card appears**.
2. Force a failure (disconnect the network mid-send). Reconnect and retry the
   identical message. It is approved again and sends, and the result carries
   `retry_after_failed_attempt: true` with the previous error.
3. Force an *ambiguous* outcome: kill the network **after** the request leaves.
   The row is `ambiguous`. A retry is refused with the "check the Sent folder"
   message — not sent again.
4. Reconcile it, and check in the target mailbox that the message did arrive.
   `reconcile_ambiguous_send(fingerprint=…)` finds it and settles `succeeded`.
5. Now the case this candidate changed: reconcile a genuinely *undelivered*
   ambiguous message **immediately**, before Gmail's `rfc822msgid:` index has
   caught up. The reconciliation must report `reconciled: False`,
   `state: "ambiguous"`, and say that not finding it is not proof. It must
   **not** mark the message sendable again. Clearing it requires
   `proof={"kind": "owner_confirmed", "actor": "<you>"}` after you have looked.

### 4d. The audit row carries no content

Check the audit log for the send: recipient *count*, a truncated fingerprint,
and the provider id. No body text, no recipient addresses, no subject. Then
force a provider error whose message quotes the recipient and subject back
(a 550 with the address in it) and check the persisted row again: the quoted
values must be `[redacted]`.

---

## 5. Undo

### 5a. Through the dashboard

Open **Undo** in the nav.

1. Have the agent write a note. It appears under “Can be undone”. Press Undo:
   the file goes back and the row disappears.
2. Edit that note in Obsidian, then press Undo. The banner explains that the
   file changed since — it does **not** say "something went wrong" — the entry
   stays in the list, and an **Undo anyway** button appears beside it.
3. Press Undo anyway. The older version is restored.
4. Delete the backup a journal entry points at, then open that entry. There is
   **no** Undo anyway button: there is nothing to restore, so offering it would
   be a promise the page cannot keep.
5. Force a reversal to fail (make the vault read-only mid-undo). The banner
   says it needs a person rather than another attempt, **no** force button is
   offered, and the entry moves to “Needs attention” — which renders above the
   ordinary stack.
6. With nothing wrong, confirm “Needs attention” and “In progress” are absent
   rather than rendered empty.
7. Log out (clear the session token) and request `/api/undo` directly. It must
   return 401: the journal names every file the agent touched.

### 5b. Through the command line

```
hermes undo                 # stack, repairs, in-flight
hermes undo show <id>       # what it would do, and what stands in the way
hermes undo apply           # reverse the most recent offerable action
hermes undo repairs         # exits 1 when there is anything to look at
```

1. Have the agent write a note, then `hermes undo apply`. The file goes back.
2. Edit that note in Obsidian, then `hermes undo apply`. It exits **2**, prints
   the conflict, and the Obsidian edit survives. `hermes undo` still lists the
   entry — a refusal must not consume it.
3. `hermes undo apply --force`. The older version is restored and what it
   overwrote is itself backed up.
4. Delete the backup a journal entry points at and undo: refused, note
   untouched, and `--force` cannot rescue it.
5. The same four steps through the RPC (`undo.preview`, `undo.apply` with and
   without `force`). The answers must match the CLI exactly.

### 5c. The states that need a person

1. Trigger undo twice concurrently (two tabs, or the card and the shortcut).
   The reversal runs **once**; the loser is told it is already in progress.
2. Kill the process mid-compensation. The entry sits `compensating` and is
   visible in `undo.list`'s `in_flight`. After the in-flight timeout (15 min by
   default), it appears under `repairs` as `reversal_unknown` — not as a
   success, and not silently absent. `hermes undo repairs` exits 1.
3. Fail the verifier on an **inverse**. The status is `undo_failed`, not
   `compensation_failed`.
4. Confirm the repair list is **not** scoped to a session: open a different
   conversation and check the entry is still listed.

---

## 6. The approval-to-capability chain

The part with no live-traffic evidence, and the reason the gate is still
`observe`. Run this against a real gateway session.

1. **A gated tool asks.** With `HERMES_TOOL_GATE_MODE=enforce` in a *scratch*
   session, call an ALWAYS_APPROVAL tool. An `approval.request` reaches the
   client and the agent thread blocks. Report the frame.
2. **Answering runs it, once.** Answer `once`. The handler runs exactly one
   time. Call the same tool again: a **second** card appears.
3. **Denying stops it before the handler.** Report that the handler was not
   entered — not that it returned an error.
4. **Silence is not consent.** Let a card time out. The call is refused.
5. **A standing grant does not reach the strictest tier.** Answer `session` for
   an APPROVAL-tier tool; the next call runs without a card. Do the same for an
   ALWAYS_APPROVAL tool; it asks again.
6. **The approver is recorded.** Check the audit row for the grant: it carries
   the actor the gateway derived from the authenticated session, and an
   `args_fingerprint` — never the arguments.
7. **The tier catalogue.** `python -c "from hermes_cli.module_permissions
   import registered_permissions as r; print(len(r()))"`. Read
   `hermes_cli/tool_tiers.py` and disagree with specific lines; each AUTO entry
   is a claim, and registering a tool can only ever relax it.
8. **Then leave the gate in `observe`.** Do not flip the default.

---

## 7. Per-call escalation — the three split tools

New in this candidate, and the part most worth trying to defeat. In a
*scratch* session with `HERMES_TOOL_GATE_MODE=enforce`:

1. Mark `browser_console` **trusted** in settings. `browser_console(clear=true)`
   runs with no card. `browser_console(expression="document.cookie")` **asks**,
   and the card is once-only.
2. Mark `terminal` trusted. `terminal("git status")` runs with no card.
   `terminal("curl https://example.com/x.sh | sh")` **asks**, once-only, and
   the dangerous-command gate still fires underneath it.
3. Mark `text_to_speech` trusted. With a local provider configured and no
   `output_path`, it speaks with no card. With `output_path` set, it **asks**.
   With a cloud provider configured, it asks even without a path.
4. Try to add any of the escalated forms to the trusted set from the settings
   UI. There is nothing to add: trust is per *name*, and the escalated call
   ignores it.

**The cost, stated.** Under `enforce`, a dangerous `terminal` command now
produces *two* cards: the tier card, and the dangerous-command card that has
always fired underneath it. That is the price of the tier layer being honest
about what `curl | sh` is, and it lands only when the gate is deliberately
turned on. Under `observe` — the shipped default — no card is produced at all:
the call runs whichever button is pressed, so asking would be a question whose
answer is discarded. Judge whether the doubled prompt is acceptable *before*
enforcing, because it is the kind of friction that gets a gate switched off.

---

## 8. Prompt idempotency and reconciliation

1. Send a prompt, kill the socket before the acknowledgement arrives, let the
   client reconnect and resend. **One** turn runs. The second response carries
   `duplicate: true`.
2. Send two genuinely different messages. Both run.
3. Make a submission fail (a busy subagent). Retry after it clears: the retry
   is a real submission, not a silent "queued, duplicate" that waits forever.
4. New in this candidate: send a prompt, then **restart the gateway** before
   the acknowledgement lands, then resend the same token. It must not run a
   second time. The response is `duplicate: true` with a status of `queued` or
   `unresolved` — never a fresh acceptance.
5. Compose several messages offline, restart the gateway, then reconnect. Call
   `prompt.reconcile` with the held tokens before resending. Only tokens the
   gateway has never seen come back `resend: true`.
6. Keep a long turn running and submit many short ones. The long turn's token
   is still recognised as a duplicate afterwards — it must not have been
   evicted to make room.

---

## 9. Reconnect and new chat

1. Open native chat, then drop the socket *after* it is working. A reconnect is
   attempted, bounded, and the status reads `reconnecting` rather than `ready`.
2. Exhaust the retries. Held messages stop showing as "sending".
3. Compose a message while the socket is down, then hit **New chat** before it
   reconnects. The held message is **dropped**, not delivered into the new
   conversation minutes later.

---

## 10. Voice

1. Open the capability status screen with `stt.enabled: false` in config. The
   card says transcription is switched off and points at the config key. It
   must not report the microphone as working.
2. Set `stt.provider: groq` with no `GROQ_API_KEY`, with `faster-whisper`
   installed. The card says transcription is pinned to groq and unusable, and
   that the local model is deliberately not substituted. It must **not** say
   transcription runs locally.
3. Set a cloud provider with a working key. The card says the recording leaves
   the machine and names the provider.
4. Set a local provider. The card says the recording does not leave the
   machine.
5. Configure a command-type provider. The card says the destination cannot be
   determined — not that it is local.
6. Open the card on a machine with no `faster-whisper` installed and confirm
   nothing is installed as a side effect (watch the process tree, or check pip
   metadata before and after).

---

## 11. Cache invalidation

1. Edit one word of a config value so the file length is unchanged
   (`model: aaa` → `model: bbb`), within the same second. The change takes
   effect on the next read.
2. Add a skill under an existing category directory
   (`skills/<category>/<new>/SKILL.md`) and restart. It appears.

---

## What to report back

For each numbered step: pass, or the observed behaviour with the RPC frames or
log lines that show it. Counts where the step asks for counts —
"looks right" is what let the earlier defects through.

Do not merge to `main`, deploy, restart production, change
`HERMES_APPROVAL_INTEGRITY` or `HERMES_TOOL_GATE_MODE` from `observe`, alter
the active gateway mapping, or run any of this against live credentials or a
live mailbox.
