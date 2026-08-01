"""The production tool catalogue, with a tier declared for every entry.

`get_tier()` defaults an unregistered tool to ALWAYS_APPROVAL, which is the
right failure mode and was, in practice, the state of almost everything: 25 of
the 104 tools this build loads carried a declared tier and the other 79 were
covered only by the default. That is safe and useless at the same time — a
catalogue where nearly every entry is "always ask" cannot be enforced, so the
gate above it has to stay in `observe` forever and the tiers mean nothing.

So every tool gets a tier, stated here, in one place, where the whole shape is
visible at once and a reviewer can disagree with a specific line.

Two rules governed the assignment, and they pull in opposite directions on
purpose:

*Registering a tool can only ever relax it.* The default is already the
strictest tier, so nothing in this file makes anything stricter than it was.
That means every AUTO line is a claim being made, and a wrong one is a hole.

*A tier that makes the product unusable will be turned off.* An `ls` that
requires a tap is a gate nobody keeps. Reads are AUTO because they are reads,
not because reads are unimportant.

The line between APPROVAL and ALWAYS_APPROVAL is not "how bad" — it is whether
a standing grant is safe. APPROVAL means the owner may mark the tool trusted
and stop being asked. ALWAYS_APPROVAL means they may not, because the action
sends something on their behalf, reaches the physical world, runs arbitrary
code, or cannot be taken back — and an action that can be pre-approved once and
then repeated unattended is an APPROVAL-tier action wearing a stricter label.

`terminal` is the entry most worth arguing about. It is APPROVAL, not
ALWAYS_APPROVAL, and the reason is that it already carries a finer gate: the
dangerous-command detector, which asks about `rm -rf /` and stays quiet about
`git status`. The tier here is a question about *the shell as a whole*, which
the owner can answer once; the per-command gate keeps firing underneath either
way, because trusting the shell is not the same as trusting every command in
it. Registering `terminal` as ALWAYS_APPROVAL would prompt twice for the
dangerous case and once for every harmless one, and would be switched off
within a day.

Tools that arrive at runtime — plugins, MCP servers, anything not in this file
— keep the ALWAYS_APPROVAL default. An unknown tool is treated as the most
restrictive, never the least, and that stays true no matter how complete this
catalogue gets.
"""
from __future__ import annotations

from hermes_cli.module_permissions import Tier

#: Read-only, query-only, or scoped to the agent's own scratch state. Nothing
#: here reaches outside the process in a way that survives being wrong.
AUTO = (
    # Browser: looking at the page, not acting on it.
    "browser_back",
    "browser_console",
    "browser_get_images",
    "browser_scroll",
    "browser_snapshot",
    "browser_vision",
    # Calendar / mail / vault reads.
    "calendar_find_free_time",
    "calendar_list_events",
    "gmail_read",
    "gmail_search",
    "vault_list",
    "vault_read",
    "vault_search",
    # Asking the owner a question is the opposite of needing permission.
    "clarify",
    # Surfaces and their state.
    "capability_list",
    "hub_context",
    "hub_navigate",
    # Feishu reads.
    "feishu_doc_read",
    "feishu_drive_list_comment_replies",
    "feishu_drive_list_comments",
    # Home Assistant: reading the house is not touching the house.
    "ha_get_state",
    "ha_list_entities",
    "ha_list_services",
    # Trackers.
    "jobs_history",
    "jobs_list",
    "jobs_summary",
    "progress_history",
    "progress_today",
    "kanban_attachments",
    "kanban_heartbeat",
    "kanban_list",
    "kanban_show",
    "project_list",
    # Local filesystem and terminal reads. Reading a file the agent already has
    # a path to adds no reach; writing one does.
    "read_file",
    "read_terminal",
    "search_files",
    # Closing a GUI tab that mirrors a background process. It does not kill the
    # process and the output keeps buffering — losing the view is recoverable
    # by opening it again.
    "close_terminal",
    "session_search",
    "skill_view",
    "skills_list",
    # Spotify: search, library reads, and player transport. The module's own
    # rule, kept — pausing the music is not a decision anyone needs to approve.
    "spotify_albums",
    "spotify_devices",
    "spotify_library",
    "spotify_playback",
    "spotify_playlists",
    "spotify_queue",
    "spotify_search",
    # Speaking out loud on the owner's own machine.
    "text_to_speech",
    # The agent's own per-session task list.
    "todo",
    # Analysis of media already in hand.
    "video_analyze",
    "vision_analyze",
    # Public web reads.
    "web_extract",
    "web_search",
    "x_search",
    # Yuanbao group reads.
    "yb_query_group_info",
    "yb_query_group_members",
    "yb_search_sticker",
)

#: Creates, changes, or spends something — but reversibly, and without acting
#: as the owner in front of anyone else. The owner may mark these trusted.
APPROVAL = (
    # Browser: acting on the page. A click can be a purchase, so it asks; it is
    # not ALWAYS_APPROVAL because a browsing session the owner is watching is
    # exactly the case where a standing grant is reasonable.
    "browser_click",
    "browser_navigate",
    "browser_press",
    "browser_type",
    # Creating calendar entries and drafts. A draft is not a send.
    "calendar_create_event",
    "calendar_create_task",
    "gmail_draft",
    # Filing something for the owner to review is not doing it.
    "capability_propose",
    # Vault and tracker writes. Reversible, journalled, and the vault stays
    # Obsidian's — these write notes, they do not become the store.
    "vault_append",
    "vault_append_daily",
    "vault_create",
    "progress_log",
    "jobs_advance",
    # Kanban writes.
    "kanban_attach",
    "kanban_attach_url",
    "kanban_block",
    "kanban_comment",
    "kanban_complete",
    "kanban_create",
    "kanban_link",
    "kanban_unblock",
    # Durable memory injected into every future turn. Reversible, but it
    # changes what the agent believes tomorrow, which is worth a prompt.
    "memory",
    # Local file writes. The dev loop, and the reason `patch` and `write_file`
    # are here rather than a tier up: they are how work gets done, they are
    # backed by version control, and an owner who is coding will trust them.
    "patch",
    "write_file",
    "project_create",
    "project_switch",
    # Subagents. Their own tool calls are gated individually at the same
    # chokepoint, so this gates the spawn, not everything downstream of it.
    "delegate_task",
    # The shell. See the module docstring: the dangerous-command gate lives
    # underneath this and keeps firing whatever the owner answers here.
    "terminal",
    # Generation that costs money on an external account.
    "image_generate",
    "video_generate",
    "xai_video_edit",
    "xai_video_extend",
)

#: Cannot be pre-approved. Sends something as the owner, reaches the physical
#: world, runs arbitrary code, or cannot be taken back.
ALWAYS_APPROVAL = (
    # Raw Chrome DevTools Protocol: arbitrary control of the browser, which is
    # arbitrary control of every logged-in session in it.
    "browser_cdp",
    # Answering a blocking JavaScript dialog. The dialog is frequently "are you
    # sure you want to delete this", and dismissing it is the decision.
    "browser_dialog",
    # Arbitrary control of the machine.
    "computer_use",
    "execute_code",
    # Scheduled autonomous execution: a grant that outlives the conversation
    # that created it, which is the exact thing a capability is meant to stop.
    "cronjob",
    # Killing processes.
    "process",
    # Installing executable skills.
    "skill_manage",
    # Sending, as the owner, to other people.
    "gmail_send",
    "discord",
    "discord_admin",
    "feishu_drive_add_comment",
    "feishu_drive_reply_comment",
    "yb_send_dm",
    "yb_send_sticker",
    # The physical world: locks, garage doors, alarms, heating. There is no
    # undo on a door.
    "ha_call_service",
)

_CATALOGUE: dict[str, Tier] = {
    **{name: Tier.AUTO for name in AUTO},
    **{name: Tier.APPROVAL for name in APPROVAL},
    **{name: Tier.ALWAYS_APPROVAL for name in ALWAYS_APPROVAL},
}


def catalogue() -> dict[str, Tier]:
    """The declared catalogue. A copy, so nothing can edit it in place."""
    return dict(_CATALOGUE)


def apply_catalogue() -> int:
    """Register every declared tier. Returns how many entries were applied.

    Modules that declare their own tier still run; `register_tool_permission`
    is a no-op when the tier matches and raises when it does not, so a module
    quietly downgrading a tool this file classifies is a loud import error
    rather than a silent hole.
    """
    from hermes_cli.module_permissions import register_tool_permission

    for name, tier in _CATALOGUE.items():
        register_tool_permission(name, tier)
    return len(_CATALOGUE)
