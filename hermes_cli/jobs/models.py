from __future__ import annotations

from typing import Literal

JobStatus = Literal[
    "packet_ready_not_applied",
    "applied",
    "pending",
    "interviewing",
    "rejected",
    "withdrawn",
    "duplicate",
    "expired",
    "offer_received",
    "offer_accepted",
]

JOB_STATUSES: tuple[JobStatus, ...] = (
    "packet_ready_not_applied",
    "applied",
    "pending",
    "interviewing",
    "rejected",
    "withdrawn",
    "duplicate",
    "expired",
    "offer_received",
    "offer_accepted",
)

ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    "packet_ready_not_applied": frozenset({
        "applied",
        "withdrawn",
        "duplicate",
        "expired",
    }),
    "applied": frozenset({
        "pending",
        "interviewing",
        "rejected",
        "withdrawn",
        "expired",
        "offer_received",
    }),
    "pending": frozenset({
        "interviewing",
        "rejected",
        "withdrawn",
        "expired",
        "offer_received",
    }),
    "interviewing": frozenset({"rejected", "withdrawn", "expired", "offer_received"}),
    "offer_received": frozenset({"offer_accepted", "rejected", "withdrawn"}),
    "rejected": frozenset(),
    "withdrawn": frozenset(),
    "duplicate": frozenset(),
    "expired": frozenset(),
    "offer_accepted": frozenset(),
}
