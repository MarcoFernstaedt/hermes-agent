"""The review queue — the single gated inbox for every proposal.

Self-extension (the agent wanting to add a skill, MCP server, plugin, tool, or
capability) and self-improvement (the platform proposing its own maintenance)
both file a *proposal* here. Nothing a proposal describes happens until a human
approves it, and applying it runs through a per-kind handler that is the only
code allowed to enact it. This is the machinery behind the invariant: the agent
proposes, the owner approves, then it happens — self-extension is never
self-authorisation.
"""
