"""Generic entity store — the spine capabilities store their records in.

A single table holds records of any declared type as JSON, with optimistic
concurrency and stable ids, so a new working area needs no bespoke schema. See
docs/plans/intelligence-hub-architecture.md (Phase B).
"""
