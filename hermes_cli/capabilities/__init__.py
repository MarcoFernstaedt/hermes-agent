"""Capability declarations shared by the agent-tool generator.

A capability is a language-neutral description of a working area (entity,
fields, lifecycle, which operations the agent may perform). The frontend
renders it into a UI (web/src/capabilities); this Python mirror lets the agent
tool registry generate a matching toolset from the same shape — "written once,
exposed twice". See docs/plans/intelligence-hub-architecture.md (Phase C).
"""
