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

Three entries are not one action
--------------------------------
A tier classifies a name, and three tools in this catalogue answer to a name
that covers two very different actions. Left alone, each one is a standing
grant on the safe form that silently covers the dangerous form:

* `browser_console` reads the page's console log — and with `expression`
  evaluates arbitrary JavaScript in the page origin, which is arbitrary code
  with the cookies of whatever is logged in.
* `text_to_speech` speaks on the owner's machine — and with `output_path`
  writes a file wherever the process can write, and with a cloud provider
  sends the text to a third party, and with a command/plugin provider runs a
  configured program.
* `terminal` runs `git status` — and runs `curl … | sh`.

The bottom of this file registers per-call escalations for those three, so the
dangerous form is ALWAYS_APPROVAL for that call and cannot be pre-approved by
trusting the name. Nothing here relaxes anything: an escalation can only raise
a tier, and the safe form keeps the tier it always had.

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
    # Browser: looking at the page, not acting on it. `browser_console` is a
    # read of the console buffer; `expression=` makes it something else and is
    # escalated below.
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
    # Speaking out loud on the owner's own machine — and only that. The
    # escalations below cover the calls where it also writes a chosen file,
    # ships the text to a cloud API, or runs a configured command.
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


# =========================================================================
# Per-call escalations
# =========================================================================
# Each returns the tier *this call* deserves, or None to leave the declared
# tier alone. They can only raise; `module_permissions.tier_for_call` treats
# the declared tier as a floor and ignores anything weaker.


def _is_given(value: object) -> bool:
    """True when an argument was actually supplied.

    `None` and an empty/whitespace string mean "not given". Anything else
    counts as given — including values of the wrong type, because a rule that
    decided a non-string `expression` was absent would be a way past it.
    """
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return True


def _browser_console_evaluates_code(args: object) -> "Tier | None":
    """`browser_console(expression=...)` is arbitrary JS in the page origin.

    Reading the console buffer is a read. Evaluating an expression runs code
    with the page's cookies, storage, and same-origin network access — the
    same reach `browser_cdp` has and is ALWAYS_APPROVAL for. The denylist in
    `browser_tool.restrict_evaluate` is off by default and, being a denylist,
    is not a substitute for asking.
    """
    if not isinstance(args, dict):
        return None
    return Tier.ALWAYS_APPROVAL if _is_given(args.get("expression")) else None


def _text_to_speech_writes_a_chosen_path(args: object) -> "Tier | None":
    """`output_path` turns speech into a file write at a caller-chosen path.

    Without it the tool writes a timestamped file into the voice-memo
    directory, which is the AUTO claim. With it, an injected prompt under a
    standing grant materialises a file of attacker-chosen bytes at an
    attacker-chosen location; the traversal check in the handler bounds where,
    not whether.
    """
    if not isinstance(args, dict):
        return None
    return Tier.ALWAYS_APPROVAL if _is_given(args.get("output_path")) else None


#: TTS backends that synthesise on this machine. Everything else in
#: `BUILTIN_TTS_PROVIDERS` posts the text to somebody's API — including the
#: default, `edge`, which is Microsoft's.
LOCAL_TTS_PROVIDERS = frozenset({"neutts", "kittentts", "piper"})


def _text_to_speech_leaves_the_machine(args: object) -> "Tier | None":
    """Escalate when the configured TTS provider is not local.

    The AUTO line for this tool says "speaking out loud on the owner's own
    machine". That is true for a local synthesiser and false for every cloud
    provider, where the text — which is whatever the agent decided to say, and
    may quote anything it just read — is sent to a third party. A configured
    command or plugin provider is stricter still: it runs a program.

    The provider is read from config rather than the arguments because that is
    where it lives; the tool takes no provider argument. A config that cannot
    be read leaves the default in place, which is remote, so the unreadable
    case escalates rather than relaxes.
    """
    from tools.tts_tool import (
        BUILTIN_TTS_PROVIDERS,
        _get_provider,
        _load_tts_config,
    )

    provider = _get_provider(_load_tts_config())
    if provider in LOCAL_TTS_PROVIDERS:
        return None
    if provider in BUILTIN_TTS_PROVIDERS:
        # A cloud API: the text leaves the machine, which is the same class of
        # decision as `image_generate` and sits at the same tier.
        return Tier.APPROVAL
    # A command-type or plugin provider: an owner-declared program runs with
    # the agent's text as input. That is code execution and cannot be a
    # standing grant.
    return Tier.ALWAYS_APPROVAL


def _terminal_runs_arbitrary_code(args: object) -> "Tier | None":
    """Escalate the shell calls the owner must not be able to pre-approve.

    `terminal` stays APPROVAL so the owner can trust the shell and stop being
    asked about `ls`. The hole that leaves is the other direction: the
    dangerous-command detector fires underneath, but its verdict is
    permanently approvable — `_permanent_approved` stores pattern keys, so a
    single "always" answer covers `curl … | sh` for the life of the install.

    Raising the *tier* for exactly the commands the detector flags closes it.
    ALWAYS_APPROVAL is minted `once_only`: no session cache, no `--yolo`, no
    permanent entry. The harmless majority is untouched, so this does not
    become a gate that gets switched off.

    A detector that raises escalates rather than passes: not being able to
    classify a command is not evidence that it is safe.
    """
    if not isinstance(args, dict):
        return None
    command = args.get("command")
    if not isinstance(command, str) or not command.strip():
        # A `terminal` call with no readable command is not a call this rule
        # can clear. The handler will reject it; the tier does not relax for
        # it in the meantime.
        return Tier.ALWAYS_APPROVAL if command is not None else None

    from tools.approval import detect_dangerous_command

    is_dangerous, _key, _description = detect_dangerous_command(command)
    return Tier.ALWAYS_APPROVAL if is_dangerous else None


#: tool name -> the rules that may raise one of its calls.
ESCALATIONS: dict[str, tuple] = {
    "browser_console": (_browser_console_evaluates_code,),
    "text_to_speech": (
        _text_to_speech_writes_a_chosen_path,
        _text_to_speech_leaves_the_machine,
    ),
    "terminal": (_terminal_runs_arbitrary_code,),
}


def apply_escalations() -> int:
    """Register every per-call escalation. Returns how many were applied.

    Idempotent: `register_call_escalation` ignores a predicate it already
    holds, so importing this more than once does not stack duplicates.
    """
    from hermes_cli.module_permissions import register_call_escalation

    applied = 0
    for name, predicates in ESCALATIONS.items():
        for predicate in predicates:
            register_call_escalation(name, predicate)
            applied += 1
    return applied


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
