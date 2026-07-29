"""Cost attribution — which *feature* caused this model call.

Part 9 of the ambient brief asks for cost visible per feature, per module, per
day. Spend was already observable per model call, but nothing recorded what
*caused* the call, so "the news implication layer costs this much" was not a
question the data could answer. Attribution is therefore a prerequisite of the
budget system rather than a readout of it, and it lands in phase 1 with the
rest of the substrate.

Two honesty rules the on-machine review was right to insist on:

**Never invent precision the provider does not supply.** Some providers return
billed cost, some return token counts we price ourselves, some return neither.
Each row records which of those happened in ``basis``, and anything we computed
rather than received is marked ``estimated``. A budget built on unlabelled
estimates would read as authoritative and quietly drift.

**Interactive and background spend are different facts.** The budget degrades
background work first and keeps owner-initiated requests running, so the origin
has to be recorded at the call, not inferred later from timing.
"""
from __future__ import annotations

import contextvars
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Optional

from hermes_sqlite import force_delete_journal_if_wal_unsafe

#: The feature currently executing, set by whatever initiated the work and read
#: at the dispatch chokepoint. A ContextVar rather than a parameter because the
#: call site is deep inside the provider layer and every intermediate frame
#: would otherwise have to thread it through.
_ACTIVE: contextvars.ContextVar[Optional["Attribution"]] = contextvars.ContextVar(
    "hermes_cost_attribution", default=None
)


@dataclass(frozen=True)
class Attribution:
    """Who to bill this call to."""

    feature: str
    module: str = ""
    action_id: str = ""
    run_id: str = ""
    #: "interactive" (the owner is waiting) or "background" (we chose to).
    origin: str = "background"
    #: Declared cost tier of the feature, 1–4. Lets the budget check whether a
    #: feature is spending above the tier it claimed in its manifest.
    tier: int = 3


def set_attribution(attribution: Optional[Attribution]):
    """Bind the active attribution. Returns a token for ``reset``."""
    return _ACTIVE.set(attribution)


def get_attribution() -> Optional[Attribution]:
    return _ACTIVE.get()


def reset_attribution(token) -> None:
    _ACTIVE.reset(token)


class attributed:
    """Context manager binding an attribution for the duration of a block.

    Re-entrant and exception-safe: an inner feature restores the outer one on
    exit, so a nested call does not permanently retag everything after it.
    """

    def __init__(self, feature: str, **kwargs: Any) -> None:
        self.attribution = Attribution(feature=feature, **kwargs)
        self._token = None

    def __enter__(self) -> Attribution:
        self._token = set_attribution(self.attribution)
        return self.attribution

    def __exit__(self, *exc: Any) -> None:
        if self._token is not None:
            reset_attribution(self._token)
        return None


class CostLedger:
    """Append-only record of model spend, tagged with what caused it."""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._migrate()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        if not force_delete_journal_if_wal_unsafe(
            conn, db_label="phase1-cost-ledger"
        ):
            conn.execute("PRAGMA journal_mode=WAL")
        return conn

    def _migrate(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS model_spend (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts            REAL NOT NULL,
                    day           TEXT NOT NULL,
                    feature       TEXT NOT NULL DEFAULT 'unattributed',
                    module        TEXT NOT NULL DEFAULT '',
                    action_id     TEXT NOT NULL DEFAULT '',
                    run_id        TEXT NOT NULL DEFAULT '',
                    origin        TEXT NOT NULL DEFAULT 'background',
                    tier          INTEGER NOT NULL DEFAULT 3,
                    provider      TEXT NOT NULL DEFAULT '',
                    model         TEXT NOT NULL DEFAULT '',
                    input_tokens  INTEGER,
                    output_tokens INTEGER,
                    cost_usd      REAL,
                    -- "billed" (provider told us), "priced" (we priced their
                    -- token counts), or "unknown" (neither was available).
                    basis         TEXT NOT NULL DEFAULT 'unknown',
                    estimated     INTEGER NOT NULL DEFAULT 1
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_spend_day ON model_spend(day)")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_spend_feature ON model_spend(feature, day)"
            )

    def record(
        self,
        *,
        provider: str = "",
        model: str = "",
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        cost_usd: Optional[float] = None,
        basis: str = "unknown",
        attribution: Optional[Attribution] = None,
        now: Optional[float] = None,
    ) -> int:
        """Append one call.

        An unattributed call is recorded as ``feature='unattributed'`` rather
        than dropped — a blind spot you can see is fixable; one you cannot see
        makes the budget quietly wrong.
        """
        attr = attribution or get_attribution() or Attribution(feature="unattributed")
        ts = time.time() if now is None else now
        day = time.strftime("%Y-%m-%d", time.gmtime(ts))
        with self._connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO model_spend
                    (ts, day, feature, module, action_id, run_id, origin, tier,
                     provider, model, input_tokens, output_tokens, cost_usd,
                     basis, estimated)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (ts, day, attr.feature, attr.module, attr.action_id, attr.run_id,
                 attr.origin, attr.tier, provider, model, input_tokens,
                 output_tokens, cost_usd, basis, 0 if basis == "billed" else 1),
            )
            return int(cur.lastrowid or 0)

    def spend_by(self, field: str, *, since_day: str = "") -> list[dict[str, Any]]:
        """Total spend grouped by feature, module, model, origin or day.

        ``known_usd`` sums only what we can defend; ``unpriced_calls`` counts
        the rest. Reporting a single number that silently treats unknown cost as
        zero is how a budget ends up wrong in the direction that hurts.
        """
        if field not in {"feature", "module", "model", "origin", "day", "tier"}:
            raise ValueError(f"cannot group spend by {field!r}")
        clause = "WHERE day >= ?" if since_day else ""
        params: list[Any] = [since_day] if since_day else []
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT {field} AS bucket,
                       COUNT(*) AS calls,
                       COALESCE(SUM(cost_usd), 0.0) AS known_usd,
                       SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced_calls,
                       SUM(CASE WHEN estimated = 1 THEN 1 ELSE 0 END) AS estimated_calls
                FROM model_spend {clause}
                GROUP BY bucket ORDER BY known_usd DESC
                """,
                params,
            ).fetchall()
        return [dict(r) for r in rows]

    def total(self, *, since_day: str = "") -> dict[str, Any]:
        clause = "WHERE day >= ?" if since_day else ""
        params: list[Any] = [since_day] if since_day else []
        with self._connect() as conn:
            row = conn.execute(
                f"""
                SELECT COUNT(*) AS calls,
                       COALESCE(SUM(cost_usd), 0.0) AS known_usd,
                       SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced_calls,
                       SUM(CASE WHEN estimated = 1 THEN 1 ELSE 0 END) AS estimated_calls
                FROM model_spend {clause}
                """,
                params,
            ).fetchone()
        out = dict(row)
        # State the confidence alongside the number, always.
        out["fully_billed"] = out["calls"] > 0 and out["estimated_calls"] == 0
        return out


def iter_tiers() -> Iterator[tuple[int, str]]:
    """The declared cost tiers, for manifests and the budget UI."""
    yield 1, "Deterministic — no model call"
    yield 2, "Auxiliary model — triage, relevance, classification"
    yield 3, "Main model — drafting, synthesis, answering"
    yield 4, "Ensemble or high reasoning — on request or genuinely consequential"
