# Native Job Application Tracker Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add an authenticated, review-only Jobs area to the native Hermes Dashboard that reads authoritative SQLite job data, safely exposes packet assets, and records explicit user-controlled application status changes without ever submitting an application.

**Architecture:** Add a small `hermes_cli.jobs` package with a repository/service boundary and an `APIRouter`, then mount that router into the existing same-origin FastAPI app before the SPA fallback. The React page uses typed functions in the existing API client and pure view/state helpers so the Node-only Vitest suite can prove rendering and interaction contracts without replacing or remounting chat.

**Tech Stack:** Python 3.11+, SQLite, FastAPI/Pydantic, pytest/TestClient, React 19, TypeScript 6, React Router 7, Tailwind/design-system components, Vitest Node static-render tests, ESLint, Ruff.

---

## 1. Decisions and boundaries

### 1.1 Authoritative data

- SQLite is authoritative for role facts, status, progress, packet records, assets, and audit history.
- Packet inventory is derived from the `assets` and `packets` rows and verified recursively beneath the configured packet root. No top-level glob is used.
- The existing production-shaped schema has `campaigns`, `jobs`, `packets`, `assets`, and `validation_events`; 75 current jobs are `packet_ready_not_applied`.
- Existing source facts are immutable through this feature. The only existing `jobs` columns this feature may update are `status` and `updated_at`; the additive migration introduces `applied_at` and `status_events`.
- Paths returned by the API are opaque asset IDs and display names only. Absolute paths, DB paths, root paths, and stored relative path strings never cross the API boundary.

### 1.2 Configuration

- `HERMES_JOBS_DB_PATH` selects the SQLite database.
- `HERMES_JOBS_PACKET_ROOT` selects the `Applications` packet root.
- If unset, paths are derived from `Path.home()` plus the established Job Search layout; no `/home/marco` literal is committed.
- Tests always inject temporary paths and never open or mutate the live database.
- A missing database/root produces a safe `503` JSON error and a useful frontend error state; it does not create an empty database in the configured location.

### 1.3 Modular ownership

Create:

- `hermes_cli/jobs/__init__.py` — package exports.
- `hermes_cli/jobs/models.py` — status constants, transition graph, Pydantic request/response models.
- `hermes_cli/jobs/repository.py` — SQLite connection, migration, list/summary queries, transactional transition and audit append.
- `hermes_cli/jobs/assets.py` — recursive asset mapping and secure path resolution.
- `hermes_cli/jobs/router.py` — FastAPI routes, config resolution, auth/origin guard, threadpool calls, safe error mapping.
- `tests/hermes_cli/jobs/conftest.py` — production-shaped temporary DB and packet-tree fixtures.
- `tests/hermes_cli/jobs/test_repository.py` — list, summary, filtering, ordering, date math, migration, transitions, audit tests.
- `tests/hermes_cli/jobs/test_assets.py` — traversal, symlink, allowlist, secret-like-file tests.
- `tests/hermes_cli/jobs/test_router.py` — API contract, auth, origin/CSRF, and file response tests.
- `web/src/lib/jobs.ts` — frontend domain types and pure filtering/state helpers.
- `web/src/lib/jobs.test.ts` — helper and payload tests.
- `web/src/pages/JobsPage.tsx` — page container and accessible components.
- `web/src/pages/JobsPage.test.tsx` — static-render and controlled-view tests.

Modify:

- `hermes_cli/web_server.py` — include the Jobs router only; do not add feature logic to this large file.
- `web/src/lib/api.ts` — add typed Jobs fetch/update/download methods using existing `fetchJSON`/`authedFetch` auth behavior.
- `web/src/lib/api.test.ts` — prove paths, query encoding, status payload, and authenticated asset fetch.
- `web/src/App.tsx` — lazy Jobs route, Jobs nav item, and Operate grouping only.

No dependency, lockfile, environment-file, service, gateway, cron, Obsidian note, or deployment changes are planned.

### 1.4 Same-origin auth and CSRF decision

- Every `/api/jobs*` path remains outside `PUBLIC_API_PATHS`; the existing dashboard middleware therefore protects it in both loopback session-token mode and gated cookie-session mode.
- Handlers also call a narrow authorization assertion compatible with `_require_token`: loopback requests require the existing `X-Hermes-Session-Token`; gated requests require the middleware-attached verified session.
- Reads and file responses rely on existing auth.
- The status write uses `PATCH` with JSON and the existing authenticated `fetchJSON` client.
- Because the dashboard has no reusable CSRF token endpoint or token protocol, no bypass/token route will be invented. In cookie-gated mode the write additionally rejects a present `Origin` or `Referer` whose normalized scheme/host differs from the externally visible request origin; requests without either header are rejected in gated browser mode. Loopback mode remains protected by the unguessable custom session header, whose cross-origin use requires a CORS preflight that the existing CORS policy denies.
- Proxy-aware comparison uses trusted request URL/forwarded host/proto handling already provided by the dashboard deployment. Tests cover same-origin success and cross-origin/missing-origin failure in gated mode.

### 1.5 Status machine

Allowed statuses:

- `packet_ready_not_applied`
- `applied`
- `pending`
- `interviewing`
- `rejected`
- `withdrawn`
- `duplicate`
- `expired`
- `offer_received`
- `offer_accepted`

Allowed transitions:

- packet ready → applied, withdrawn, duplicate, expired
- applied → pending, interviewing, rejected, withdrawn, expired, offer received
- pending → interviewing, rejected, withdrawn, expired, offer received
- interviewing → rejected, withdrawn, expired, offer received
- offer received → offer accepted, rejected, withdrawn
- rejected, withdrawn, duplicate, expired, and offer accepted are terminal

A no-op transition and all edges absent from this graph return `409`. In particular, packet-ready cannot become pending/interviewing/offer without first recording `applied`; packet-ready is never counted as submitted. `offer_accepted` is an explicit terminal campaign stop signal surfaced in the response and UI; it does not execute any automation.

On the first transition to `applied`, `applied_at` receives the injected UTC timestamp. Later transitions retain it. A transaction updates `jobs.status`, `jobs.updated_at`, and conditionally `jobs.applied_at`, then inserts one `status_events` row. Any failure rolls back both changes.

### 1.6 Additive schema migration

Migration pseudocode:

```text
BEGIN IMMEDIATE
columns = PRAGMA table_info(jobs)
if applied_at missing:
    ALTER TABLE jobs ADD COLUMN applied_at TEXT NULL
CREATE TABLE IF NOT EXISTS status_events (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    from_status TEXT NOT NULL,
    to_status TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'dashboard'
)
CREATE INDEX IF NOT EXISTS idx_status_events_job_changed
    ON status_events(job_id, changed_at DESC)
COMMIT
```

The migration is idempotent and transactional. It is run before repository reads/writes, against an explicit existing database only. Tests copy/create the production column shape, run migration twice, verify existing facts byte-for-byte, and verify rollback on an injected migration failure.

### 1.7 Summary and date math

Backend receives an injectable `now` for deterministic tests and uses UTC calendar boundaries:

- qualified packet-ready: `status = packet_ready_not_applied` and verdict is actionable (`apply` or `stretch`), with a packet row present
- applied: current `status = applied`
- pending response: current `status = pending`
- interviewing: current `status = interviewing`
- rejected: current `status = rejected`
- expired/closed: current `status = expired`
- offers: current `status = offer_received`
- accepted offer: current `status = offer_accepted`
- today prepared: jobs with a packet and `date_found = UTC today`; target 300
- current week applied: jobs with non-null `applied_at` in `[Monday 00:00 UTC, next Monday 00:00 UTC)`; target 1500

Withdrawn and duplicate remain filterable but are not folded into another summary count. Counts are SQL joins/aggregates, not filesystem glob counts.

### 1.8 Listing, filtering, and freshness

`GET /api/jobs` accepts optional repeated/single query values:

- `status`
- `lane`
- `freshness` (`active`, `stale`, `unknown`)
- `q`

Text search is case-insensitive over company, role title, location, lane, and requisition ID. Values are bound SQL parameters; sort keys are fixed SQL expressions.

Freshness derivation is conservative:

- active: newest successful `validation_events.checked_at` is within 7 UTC days
- stale: newest validation exists but is older than 7 days, or its latest event reports failure/closure evidence
- unknown: no usable validation timestamp

Default order is:

1. actionable status (`packet_ready_not_applied`, `applied`, `pending`, `interviewing`, `offer_received`)
2. fit score descending
3. freshness rank active, unknown, stale
4. checked/date-found descending
5. job ID ascending for stability

### 1.9 Packet asset security boundary

Only asset rows associated with the requested job are candidates. Allowed types/extensions:

- `application_packet`: `.md`
- `job_information`: `.md`
- `resume_docx`: `.docx`
- `resume_txt`: `.txt`

Resolution pseudocode:

```text
asset = SELECT ... WHERE assets.id = ? AND packets.job_id = ?
reject unknown asset type or extension mismatch
reject absolute stored path
strip exactly one leading Applications component when present
candidate = packet_root / relative_asset_path
resolved_root = packet_root.resolve(strict=True)
resolved_candidate = candidate.resolve(strict=True)
reject unless resolved_candidate.is_relative_to(resolved_root)
reject if candidate or any component below root is a symlink
reject secret-like basename/suffix (.env, key, token, secret, credential,
       cookie, .pem, .key, id_rsa/id_ed25519, backup/database/archive forms)
reject non-regular file
return FileResponse with safe basename and attachment/inline disposition
```

The list API returns `{id, type, name, media_type, download_url, open_url}`. It never returns stored `path`, `folder_path`, or any absolute path. Recursive packet truth comes from joined DB asset rows and secure per-file existence checks beneath the packet root.

### 1.10 API contract

`GET /api/jobs/summary`

```json
{
  "counts": {
    "qualified_packet_ready": 75,
    "applied": 0,
    "pending": 0,
    "interviewing": 0,
    "rejected": 0,
    "expired": 0,
    "offer_received": 0,
    "offer_accepted": 0
  },
  "today_prepared": {"current": 50, "target": 300},
  "week_applied": {"current": 0, "target": 1500},
  "campaign_stop": false,
  "as_of": "2026-07-17T...Z"
}
```

`GET /api/jobs?status=...&lane=...&freshness=...&q=...`

```json
{
  "items": [{
    "id": 1,
    "company": "…",
    "role_title": "…",
    "lane": "…",
    "location": "…",
    "work_mode": "…",
    "pay": null,
    "fit_score": 92,
    "verdict": "apply",
    "date_found": "2026-07-17",
    "checked_at": "2026-07-17T...Z",
    "freshness": "active",
    "source_url": "https://…",
    "apply_url": "https://…",
    "fit_rationale": "…",
    "gaps": [],
    "blockers": [],
    "recommended_action": "…",
    "status": "packet_ready_not_applied",
    "applied_at": null,
    "assets": [{"id": 1, "type": "resume_txt", "name": "Resume.txt", "media_type": "text/plain", "download_url": "/api/jobs/1/assets/1?disposition=attachment", "open_url": "/api/jobs/1/assets/1?disposition=inline"}]
  }],
  "filters": {"statuses": [], "lanes": [], "freshness": ["active", "stale", "unknown"]},
  "total": 75
}
```

`PATCH /api/jobs/{job_id}/status`

Request: `{"status":"applied"}`

Success:

```json
{
  "job_id": 1,
  "from_status": "packet_ready_not_applied",
  "status": "applied",
  "updated_at": "2026-07-17T...Z",
  "applied_at": "2026-07-17T...Z",
  "campaign_stop": false,
  "announcement": "Status updated to Applied."
}
```

Errors: `401` unauthenticated, `403` failed same-origin check, `404` unknown job/asset, `409` invalid transition, `422` invalid filter/status/disposition, `503` unconfigured/missing data.

`GET /api/jobs/{job_id}/assets/{asset_id}?disposition=inline|attachment`

Returns the allowlisted file with `Content-Disposition`, `X-Content-Type-Options: nosniff`, restrictive `Content-Security-Policy` for inline text, and `Cache-Control: private, no-store`.

There are no endpoints for submit, message, employer account, URL fetch, packet write, source-fact edit, or arbitrary path read.

### 1.11 Frontend state and accessibility

`JobsPage` owns:

- `loading | ready | error` request state
- summary and role list
- status/lane/freshness/search filters
- per-role expanded details
- per-role pending status update and error
- a polite live-region announcement
- refs for the changed card heading/status control

The page renders:

- `<main aria-labelledby="jobs-heading">` and one `<h1 id="jobs-heading">Jobs</h1>`
- compact summary cards and two labeled `<progress>` elements
- a labeled search field and native labeled selects (keyboard-safe by default)
- an ordered/list region of mobile-first role `<article>` cards, never a dense table
- one clear heading per role; concise location/work mode/pay/fit/freshness/status text
- explicit “Open apply page” and “Open source” external links with `target="_blank"` and `rel="noopener noreferrer"`
- details disclosure, concise lists for fit/gaps/blockers/action, and assets with “Open …” / “Download …” names
- a labeled status select and explicit “Update status” button; no status changes on selection alone
- visible pending/success/failure status plus `aria-live="polite"`; after success, focus returns to the updated card heading/control without scrolling unexpectedly
- 44px minimum controls via `min-h-11`; visible focus styles inherited from the design system
- no custom animation; existing theme reduced-motion behavior remains intact
- loading skeleton/status, retryable error alert, no-results state, and no-data empty state
- accepted-offer banner: “Offer accepted. Campaign stop signal is active.” It provides no automation control.

Minimal copy rule: headings, labels, statuses, facts, and one-sentence state messages only. No promotional prose, implementation jargon, submission language, or claims that packet-ready means applied.

### 1.12 Deployment and rollback

Deployment is explicitly out of scope for this task. Reviewer/deployer steps later:

1. Back up the SQLite database through the approved operations process.
2. Configure/verify the two Jobs paths without exposing them to the browser.
3. Build and install the accepted commit.
4. Start/restart only with separate approval.
5. Authenticated smoke: summary, filters, one safe packet open/download, and a pre-approved reversible test transition in a non-production copy first.

Code rollback: revert the implementation commit and rebuild through the normal release process. Data rollback: application code tolerates additive `applied_at` and `status_events`; removing them is unnecessary and riskier. If a status must be corrected, use an approved SQL rollback transaction based on `status_events`; do not delete source job facts. `offer_accepted` remains terminal in the UI.

### 1.13 Alternatives considered

- **Put everything in `web_server.py`: rejected.** The file is already very large; repository/security logic needs isolated tests and ownership.
- **Use a frontend-only SQLite bridge or read packet folders directly: rejected.** Browsers cannot safely access SQLite/files, and filesystem-only counts violate authoritative-data requirements.
- **Use a plugin tab: rejected.** This is a requested native route with stable same-origin auth and navigation, not an optional third-party plugin.
- **Add an ORM/migration dependency: rejected.** A small idempotent SQLite migration is sufficient and avoids dependency/lockfile changes.
- **Use query-token download links: rejected.** The existing query-token exception is intentionally narrow; Jobs uses authenticated fetch-to-blob/open behavior so credentials are not placed in URLs.
- **Infer applied from packet existence: rejected.** Packet-ready and submitted are distinct states.
- **Automatically stop jobs/application systems on offer acceptance: rejected.** The tracker only emits a visible/data stop signal; no autonomous action is permitted.
- **Permit arbitrary status correction edges: rejected.** Explicit adjacency catches accidental skips and preserves trustworthy funnel metrics.

### 1.14 Known blockers/risks

- The live database is not modified during implementation or tests. Live migration/deployment proof is therefore deferred to `imperator-ops` after review and approval.
- The production asset paths include an `Applications/` prefix while the configured packet root is the `Applications` directory; the resolver must normalize exactly that one prefix and reject all other root changes.
- Existing dashboard writes do not expose a general CSRF token helper. This plan uses the existing authentication model plus a route-local same-origin guard rather than inventing an unauthenticated token endpoint.
- Node-only Vitest cannot prove browser focus movement end-to-end. Pure controlled-view/static contracts are tested here; reviewer browser smoke is required after an approved deployment.

## 2. Vertical TDD implementation tasks

Every production behavior follows RED → GREEN before the next behavior. Record each focused command and expected failure in the implementation evidence notes/commit message summary. Do not write all tests first.

### Task 1: Commit this architecture plan

**Objective:** Establish the approved artifact before production code.

**Files:**
- Create: `docs/plans/2026-07-17-native-job-application-tracker.md`

**Step 1:** Run `git diff --check` and inspect `git diff -- docs/plans/2026-07-17-native-job-application-tracker.md`.

**Step 2:** Run `git status --short --branch`; expected only this plan is untracked/added.

**Step 3:** Commit only the plan:

```bash
git add docs/plans/2026-07-17-native-job-application-tracker.md
git commit -m "docs: plan native job application tracker"
```

### Task 2: Migrate a production-shaped database idempotently

**Objective:** Add only status timestamp/audit structures without changing source facts.

**Files:**
- Create: `tests/hermes_cli/jobs/conftest.py`
- Create: `tests/hermes_cli/jobs/test_repository.py`
- Create: `hermes_cli/jobs/__init__.py`
- Create: `hermes_cli/jobs/models.py`
- Create: `hermes_cli/jobs/repository.py`

**Step 1 RED:** Add one test that creates the exact known jobs/packets/assets/validation columns, snapshots source facts, runs `migrate()` twice, and expects one nullable `applied_at`, one `status_events` table/index, and unchanged facts.

Run: `pytest -q tests/hermes_cli/jobs/test_repository.py::test_migration_is_additive_idempotent_and_preserves_source_facts`

Expected RED: import/module/function missing.

**Step 2 GREEN:** Implement only connection validation and the transaction pseudocode above.

Run the same command; expected `1 passed`.

**Step 3 RED/GREEN:** Add rollback-on-injected-failure test, run RED, add minimal transaction rollback, run GREEN.

### Task 3: List, filter, order, and summarize jobs

**Objective:** Return authoritative role data/counts with deterministic date math.

**Files:**
- Modify: `tests/hermes_cli/jobs/test_repository.py`
- Modify: `hermes_cli/jobs/models.py`
- Modify: `hermes_cli/jobs/repository.py`

Vertical slices:

1. RED/GREEN production-shaped row decoding, including malformed JSON safely becoming an empty list without leaking raw data.
2. RED/GREEN default actionable/fit/freshness/date/stable ordering.
3. RED/GREEN each status, lane, freshness, and text filter with SQL parameter binding.
4. RED/GREEN freshness at 7-day boundary and unknown validation.
5. RED/GREEN each summary status count while packet-ready remains distinct from applied.
6. RED/GREEN today-prepared UTC boundary/target 300.
7. RED/GREEN Monday-to-next-Monday applied boundary/target 1500.
8. RED/GREEN accepted-offer campaign stop boolean.

Focused command after each slice:

```bash
pytest -q tests/hermes_cli/jobs/test_repository.py -k '<slice name>'
```

Then run the file; expected all repository tests pass.

### Task 4: Enforce every status transition transactionally

**Objective:** Validate the state machine and atomically update status/timestamps/audit.

**Files:**
- Modify: `tests/hermes_cli/jobs/test_repository.py`
- Modify: `hermes_cli/jobs/models.py`
- Modify: `hermes_cli/jobs/repository.py`

For each source state, use one parameterized vertical test group:

1. RED: assert every documented valid edge succeeds, writes exactly one audit event, updates `updated_at`, and sets/retains `applied_at` correctly.
2. GREEN: implement the fixed transition map and transactional method.
3. RED: assert every undocumented edge, unknown status, unknown job, and same-status request fails without any row/audit change.
4. GREEN: add minimal domain errors and rollback behavior.
5. RED/GREEN: explicit `offer_received → offer_accepted` returns `campaign_stop=true` and accepted is terminal.
6. RED/GREEN: injected audit insert failure rolls back the job update.

Run focused parameter IDs while iterating, then:

```bash
pytest -q tests/hermes_cli/jobs/test_repository.py
```

### Task 5: Resolve packet assets safely

**Objective:** Expose only DB-associated allowlisted files beneath the packet root.

**Files:**
- Create: `tests/hermes_cli/jobs/test_assets.py`
- Create: `hermes_cli/jobs/assets.py`

Vertical RED/GREEN slices:

1. Valid `Applications/...` DB path normalization and safe relative display metadata.
2. Recursive nested assets are found from DB rows, not a flat glob.
3. Unknown asset/job association rejection.
4. Absolute path and `..` traversal rejection.
5. Escaping final symlink and intermediate-directory symlink rejection.
6. Asset-type/extension mismatch rejection.
7. Secret-like names/extensions and non-regular files rejection.
8. Returned metadata contains no absolute/root/stored path.

Run each exact test while iterating, then:

```bash
pytest -q tests/hermes_cli/jobs/test_assets.py
```

### Task 6: Add authenticated same-origin Jobs APIs

**Objective:** Mount safe list/summary/status/file routes in the native backend.

**Files:**
- Create: `tests/hermes_cli/jobs/test_router.py`
- Create: `hermes_cli/jobs/router.py`
- Modify: `hermes_cli/jobs/__init__.py`
- Modify: `hermes_cli/web_server.py`

Vertical RED/GREEN slices:

1. Unauthenticated list, summary, status write, and asset requests return `401`.
2. Authenticated list/summary routes return the contract and validated filters; missing config returns safe `503`.
3. Status endpoint accepts valid JSON and maps not-found/conflict/validation errors without details.
4. Gated cookie write accepts same-origin and rejects cross-origin/missing Origin+Referer; loopback custom-header write succeeds.
5. Asset endpoint returns allowed bytes/content headers and maps every resolver rejection to `404` (no path oracle).
6. Router is mounted before SPA fallback; unrelated route smoke remains green.

Run focused tests, then:

```bash
pytest -q tests/hermes_cli/jobs/test_router.py tests/hermes_cli/test_web_server.py tests/hermes_cli/test_dashboard_auth_middleware.py
```

### Task 7: Add typed API client methods

**Objective:** Reuse native auth/client behavior for Jobs requests and blob assets.

**Files:**
- Modify: `web/src/lib/api.test.ts`
- Modify: `web/src/lib/api.ts`
- Create: `web/src/lib/jobs.ts`

Vertical RED/GREEN slices:

1. `getJobs` encodes only selected filters/search.
2. `getJobsSummary` uses the summary route.
3. `updateJobStatus` sends `PATCH`, JSON content type, and `{status}` only.
4. `fetchJobAsset` uses `authedFetch`, validates response success, and never adds credentials to the URL.
5. Domain types enumerate all statuses/freshness values.

Run each Vitest name, then:

```bash
npm --workspace web test -- src/lib/api.test.ts src/lib/jobs.test.ts
```

### Task 8: Render summary and role cards through a pure view seam

**Objective:** Build accessible mobile-first cards with complete facts and states.

**Files:**
- Create: `web/src/pages/JobsPage.test.tsx`
- Create: `web/src/pages/JobsPage.tsx`
- Modify: `web/src/lib/jobs.test.ts`
- Modify: `web/src/lib/jobs.ts`

Vertical RED/GREEN slices:

1. Loading view has named main/heading and visible loading status.
2. Error view has alert and named Retry button.
3. Empty and filtered-no-results views are distinct.
4. Summary renders all required distinct counts plus labeled progress.
5. Role card renders company/title/location/work mode/pay conditionally/fit/freshness/date/status/links.
6. Details render concise fit/gaps/blockers/action and safe named asset controls.
7. Status select/button accessible names include the role; controls are explicit and 44px minimum.
8. Offer accepted banner and card state expose the campaign stop signal without automation controls.
9. Minimal-copy regression rejects banned submit/message/account/fetch implementation copy.

Use exported `JobsView` with controlled props for Node static rendering. Run each test by name before implementation, then the page test file.

### Task 9: Add filters, keyboard-safe updates, and focus/live state

**Objective:** Make the page functional without sacrificing accessible state handling.

**Files:**
- Modify: `web/src/lib/jobs.test.ts`
- Modify: `web/src/lib/jobs.ts`
- Modify: `web/src/pages/JobsPage.test.tsx`
- Modify: `web/src/pages/JobsPage.tsx`

Vertical RED/GREEN slices:

1. Pure filter-state helper builds status/lane/freshness/search request.
2. Search and native controls have labels and preserve Enter/Space browser behavior (no click-only divs).
3. Status update calls exact `(jobId, status)` payload only after explicit button activation.
4. Optimistic state is not used; successful server response updates role/summary, announces result, and provides focus target.
5. Failure retains prior status, exposes alert/live text, and re-enables controls.
6. Asset open/download uses authenticated blob handling and revokes object URLs after use.

Node tests prove reducer/view contracts; browser focus movement is listed for deployment smoke.

### Task 10: Integrate native route/navigation without disturbing chat

**Objective:** Add `/jobs` as a lazy built-in page in Operate.

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/pages/JobsPage.test.tsx` or add the smallest existing App/navigation contract test location.

**Step 1 RED:** Add a source/contract test asserting `/jobs`, label `Jobs`, lazy page, and Operate grouping while existing `/chat`, `/sessions`, profiles, and persistent chat host remain present.

**Step 2 GREEN:** Add `BriefcaseBusiness` icon import, lazy page, route map entry, nav item, and Operate path only.

**Step 3:** Run focused test and existing chat/navigation component tests.

### Task 11: Refactor only after all slices are green

**Objective:** Remove duplication while preserving behavior.

- Extract repeated test builders and UI subcomponents only where already duplicated.
- Keep SQL in repository, path policy in assets, HTTP mapping in router, request transport in API client, and rendering in page.
- Do not reformat unrelated `web_server.py`, `App.tsx`, or `api.ts` regions.
- Run focused suites after each refactor.

### Task 12: Final acceptance gates and implementation commit

**Objective:** Produce proof for the exact clean tree committed.

Run, in order after the final edit:

```bash
pytest -q tests/hermes_cli/jobs tests/hermes_cli/test_web_server.py tests/hermes_cli/test_dashboard_auth_middleware.py
npm --workspace web test
npm --workspace web run typecheck
npm --workspace web exec eslint -- web/src/pages/JobsPage.tsx web/src/pages/JobsPage.test.tsx web/src/lib/jobs.ts web/src/lib/jobs.test.ts web/src/lib/api.ts web/src/lib/api.test.ts web/src/App.tsx --max-warnings=0
npm --workspace web run build
npm audit --workspaces=false --audit-level=moderate
ruff check hermes_cli/jobs tests/hermes_cli/jobs hermes_cli/web_server.py
ruff format --check hermes_cli/jobs tests/hermes_cli/jobs
git diff --check
```

Secret/private-path scan tracked diff and build without printing matched values:

```bash
git diff --cached --name-only -z | xargs -0 python <redacted-pattern scanner>
python <redacted-pattern scanner> web/dist
```

The scanner reports only file/count/status (`clean` or `needs review`), never candidate secret values. Also assert tracked changes contain no `/home/marco`, no live DB bytes, no `.env`, and no absolute packet paths.

Inspect:

```bash
git status --short --branch
git diff --stat HEAD
git diff --name-only HEAD
git diff HEAD -- hermes_cli/web_server.py web/src/App.tsx
```

Commit all accepted implementation/test files separately from the plan:

```bash
git add hermes_cli/jobs hermes_cli/web_server.py tests/hermes_cli/jobs web/src/App.tsx web/src/lib/api.ts web/src/lib/api.test.ts web/src/lib/jobs.ts web/src/lib/jobs.test.ts web/src/pages/JobsPage.tsx web/src/pages/JobsPage.test.tsx
git commit -m "feat: add native job application tracker"
```

Then rerun lightweight exact-tree proof:

```bash
git status --short --branch
git rev-parse HEAD
git show --stat --oneline --decorate --no-renames HEAD
git diff --check HEAD^
```

Do not push, merge, restart, deploy, modify the live vault, or submit applications. Hand off commit SHA, exact files, RED/GREEN command evidence, counts, blockers, and rollback/deployment notes to `imperator-ops` for review.
