# Harness Improvements Audit

A survey of improvement opportunities in the agent harness core (conversation
loop, tool dispatch, API-call helpers, CLI orchestrator, and supporting
infrastructure), produced from a read of the code on `main` as of July 2026.

Every item below cites the evidence it rests on. Items are framed as
*candidates*: several touch code where the current shape may be deliberate
(this repo's own rubric — "verify the premise" — applies to this document
too). Nothing here proposes new model tools, cache-breaking behavior, or
speculative hooks; the focus is the shape and safety of what already exists.

Priority key: **P1** = highest leverage / known wanted work, **P2** = real
but needs design discussion, **P3** = opportunistic.

---

## 1. God-function extraction (P1 — explicitly wanted per AGENTS.md)

AGENTS.md already declares "Refactor god-files into clean modules" as wanted
work. The largest remaining monoliths, measured by AST:

| Function | File | Lines |
|---|---|---|
| `run_conversation` | `agent/conversation_loop.py` | 4,163 |
| `HermesCLI.run` | `cli.py` | 2,488 |
| `init_agent` | `agent/agent_init.py` | 1,655 |
| `interruptible_streaming_api_call` | `agent/chat_completion_helpers.py` | 1,101 |
| `execute_tool_calls_sequential` | `agent/tool_executor.py` | 666 |
| `resolve_provider_client` | `agent/auxiliary_client.py` | 650 |
| `HermesCLI.chat` | `cli.py` | 639 |
| `HermesCLI.process_command` | `cli.py` | 585 |

- **`run_conversation` (4,163 lines).** The extraction pattern already
  exists and works: the prologue moved to `build_turn_context`
  (`agent/turn_context.py`) and the epilogue to `finalize_turn`
  (`agent/turn_finalizer.py`). What remains inline is the middle: the
  API-call attempt/retry state machine (including the nested
  `_perform_api_call` closure at `agent/conversation_loop.py:1139` and a
  very long provider-error dispatch section spanning roughly lines
  1900–3900), response classification (truncation, think-blocks, codex
  acks), and the post-response tool-call handoff. Candidate next slices,
  following the established pattern of module-level functions that take
  `agent` and mutate the same locals:
  1. the provider-error → fallback/rate-limit/compression decision ladder,
  2. the length-continuation / truncated-tool-call retry logic,
  3. the final-response assembly (think-scrubbing, natural-ending checks).
  Each slice is independently testable, and the current nesting (closures
  capturing ~30 loop locals) is the main obstacle to unit-testing error
  paths today.
- **`cli.py` (15,487 lines total; `run` 2,488; `__init__` 462; `main`
  495).** Same treatment as `gateway/run.py` mixins. The slash-command
  handlers alone account for a large share (see §2).
- **`init_agent` (1,655 lines).** Sections are already delimited by
  comments; splitting into phase functions (credentials/routing, toolset
  resolution, session wiring, display) would let tests construct partial
  agents without monkeypatching the world.

## 2. Slash-command dispatch: registry exists, dispatch is still an elif ladder (P2)

`hermes_cli/commands.py` is a genuine single source of truth for metadata
(help, aliases, completion, Telegram/Slack menus), but *dispatch* is still a
69-branch `elif canonical == ...` ladder inside `HermesCLI.process_command`
(`cli.py`, 585 lines), plus a parallel ladder in `gateway/run.py`.

Candidate: add an optional `handler` name to `CommandDef` (or adopt a naming
convention: `canonical "foo"` → `self._cmd_foo`) and reduce
`process_command` to resolve-and-call. This keeps the "adding an alias
touches one file" property and extends it to "adding a command touches the
registry + one handler method", removing the third wiring step from the
documented Adding-a-Slash-Command flow. The gateway ladder can share the
same convention against its own handler namespace.

Caveat: several branches have irregular signatures (some take
`cmd_original`, some parse args inline). A uniform handler signature
(`handler(self, args: str)`) is the design decision to settle first.

## 3. Acknowledged mirror-code that must be kept in sync by hand (P1)

Three places maintain two nearly-parallel implementations where the code
comments themselves say the paths must mirror each other. Each is a standing
source of "fixed in one path, still broken in the sibling" bugs — the exact
bug class the repo's own history-check culture tries to prevent (cf. commit
`2d286a6` "close tool-call sequence on all interrupt aborts, not just
finalize_turn").

1. **Tool execution: `execute_tool_calls_sequential` (666 lines) vs
   `execute_tool_calls_concurrent` (565 lines)** in
   `agent/tool_executor.py`. Both re-implement: interrupt-skip result
   synthesis, arg parsing, Tool Search unwrap + scope gate, guardrail
   blocks, middleware invocation, result budgeting, session-DB flush, and
   post-tool hooks. Comments at `agent/tool_executor.py:888` ("see
   execute_tool_calls_concurrent for full rationale") and `:1413` ("both
   paths must feed …") document the manual-sync contract.
   Candidate: extract one `_execute_single_tool_call(agent, tool_call, ...)
   -> ToolCallOutcome` pipeline both paths call, so the fork is only
   "in-line loop" vs "thread pool + ordered collection". Sequential-only
   behaviors (interactive tools, early `break` on interrupt) stay in the
   thin drivers.
2. **API calls: `interruptible_api_call` (426 lines) vs
   `interruptible_streaming_api_call` (1,101 lines)** in
   `agent/chat_completion_helpers.py`. The non-streaming stale-call timeout
   explicitly "mirrors streaming stale detector"
   (`chat_completion_helpers.py:256`), and payload sanitization is
   duplicated by design (`:1364` "so mirror that sanitization here").
   Candidate: shared pre-flight (sanitization, timeout resolution, payload
   shaping) and shared post-flight (usage accounting, error classification)
   with only the transport loop differing.
3. **Auxiliary LLM: `call_llm` (470 lines) vs `async_call_llm` (385
   lines)** in `agent/auxiliary_client.py` — classic sync/async fork.
   Candidate: implement once (async) and expose the sync form via a small
   runner, or generate both from a shared request-builder + response-parser
   so the fork is only the I/O call.

## 4. Static safety on the Python core (P2)

- **No Python type checking in CI.** `.github/workflows/typecheck.yml`
  covers only the TS packages (`ui-tui`, `web`, `apps/*`). The narrow waist
  — `tools/registry.py`, `toolsets.py`, `agent/iteration_budget.py`,
  `agent/prompt_caching.py`, message-shape helpers — is exactly where a
  wrong `dict` shape propagates furthest. Candidate: pyright/mypy on an
  explicit allowlist of small, already-typed modules, ratcheted outward.
  The pyproject comment ("while we wrangle typechecks") suggests this is
  already intended; an allowlist makes it landable incrementally instead of
  all-at-once.
- **Ruff runs exactly one rule** (`PLW1514`, deliberately — see
  `pyproject.toml`). A conservative ratchet worth considering: `F821`
  (undefined names), `F811` (redefinition), `B` bugbear's
  mutable-default/late-binding-loop rules — the categories that catch real
  runtime bugs rather than style. Per-file ignores keep legacy files quiet
  until touched.
- **Broad exception handlers**: `except Exception` appears 91× in
  `run_agent.py`, 303× in `cli.py`, 38× in `agent/tool_executor.py`. Many
  are correct crash-shields around callbacks/plugins, but an audit pass
  distinguishing "shield + `logger.debug`" from "swallow silently" would be
  cheap; the silent ones hide exactly the integration bugs the E2E policy
  worries about. `agent/error_classifier.py` already exists as the natural
  routing point.

## 5. Performance candidates (P3 — measure first)

- **Per-call `copy.deepcopy` of the full message list.** The Anthropic
  cache-marker pass deep-copies `api_messages` every call
  (`agent/prompt_caching.py:62`), and provider-shape transforms do the same
  (`run_agent.py:4569`, `:4597`, `:4800`). On a long conversation each API
  call pays O(context) CPU and transient memory, potentially several times.
  The isolation is load-bearing (stored history must not grow
  `cache_control` keys), but a shallow list copy + copy-on-write of only
  the 4 marked messages achieves the same isolation for the caching pass.
  Measure on a large session before bothering — this only matters at big
  contexts, which is also exactly when it matters most.
- **Startup import cost.** `cli.py` at 15.5k lines plus its import graph is
  paid on every `hermes` invocation, including trivial subcommands.
  `tools/lazy_deps.py` shows the pattern is already in use; a
  `python -X importtime` pass would show whether subcommand paths
  (e.g. `hermes cron list`) can avoid importing the agent stack at all.

## 6. Self-documented footguns that could be engineered away (P2)

These are pitfalls AGENTS.md warns contributors about — each warning is a
maintenance cost that a small mechanism change could delete:

- **Three config loaders.** `load_cli_config()` (CLI), `load_config()`
  (`hermes_cli/config.py`), and the gateway's raw YAML read. AGENTS.md
  itself documents the failure mode: "If you add a new key and the CLI sees
  it but the gateway doesn't … you're on the wrong loader." Candidate: one
  loader that merges `DEFAULT_CONFIG` + user YAML, with the CLI and gateway
  layering their deltas on top — so a new key defaults consistently
  everywhere. (Deliberate-design check applies: the gateway's raw read may
  exist to avoid importing CLI-side deps; that constraint can be honored by
  putting the shared loader in a dep-light module.)
- **Plugin discovery timing.** `discover_plugins()` runs only as an import
  side effect of `model_tools.py`; every other entry point must remember to
  call it explicitly (AGENTS.md "Discovery timing pitfall"). Candidate: a
  tiny `ensure_plugins_discovered()` called from the handful of entry
  points (CLI main, gateway startup, cron scheduler, tui_gateway), making
  the side-effect path redundant rather than load-bearing.
- **Tool wiring is a two-file dance with a silent failure mode.** A
  registered tool that isn't added to a toolset imports fine and silently
  never appears (AGENTS.md documents this as "a deliberate, manual step").
  Keeping the manual step is fine; adding a startup `logger.warning` for
  "registered but not in any toolset" (suppressible for intentionally
  dormant tools) would catch the classic contributor mistake without
  changing the design.

## 7. Test-suite ergonomics (P3)

The per-file subprocess isolation in `scripts/run_tests.sh` is a deliberate
correctness choice (no module-level leakage), and CI fits in a 30-minute
budget — no change needed there. Two opportunistic improvements:

- A documented "fast tier" (e.g. `scripts/run_tests.sh tests/agent
  tests/run_agent`) for the inner loop when touching the harness core, so
  contributors don't discover the right subset by folklore.
- The audit in §3 (unifying mirror paths) is also a test-coverage
  multiplier: today every behavior in the tool-execution pipeline needs the
  test written twice (sequential + concurrent) to be actually covered.

## Explicit non-recommendations

Checked and deliberately *not* proposed, per the contribution rubric:

- No new core tools, hooks without consumers, or `HERMES_*` env vars.
- No change to the sacred per-conversation cache behavior; every
  refactor above must keep the system prompt byte-stable and message-role
  alternation intact (§1 and §3 are pure code-motion in that respect).
- No pagination/lazy-reading on instructional tools.
- The `sequential` vs `concurrent` executor *split itself* is not the
  target — interactive tools genuinely need the sequential driver. Only the
  duplicated per-call pipeline inside the two drivers is.
