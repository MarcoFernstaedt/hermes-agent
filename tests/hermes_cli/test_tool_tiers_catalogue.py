"""Every tool the build loads has a declared tier — checked against the build.

A catalogue is only worth having if it matches what actually ships. These
tests import the real tool surface (`model_tools`, which is what populates the
registry in production) and compare it against the declaration, in both
directions: no tool without a tier, and no tier for a tool that no longer
exists. The second direction matters as much as the first — a stale entry for
a deleted tool is how a catalogue starts lying about its own coverage.

The reason coverage is the property under test, rather than any particular
assignment: `get_tier()` defaults an unregistered tool to ALWAYS_APPROVAL, so
before this catalogue existed the system was *safe* and unusable — 79 of 104
tools sat on the default, which meant the gate above them could never be
switched to enforce. Registering a tool can only ever relax it, so complete
coverage is what makes enforcement reachable, and each AUTO line is a claim
somebody has to be willing to defend.
"""
from __future__ import annotations

import pytest

from hermes_cli.module_permissions import Tier, get_tier
from hermes_cli import tool_tiers


@pytest.fixture(scope="module")
def build_surface() -> dict:
    """The real production tool surface, enumerated in a *fresh* process.

    Not by importing here. The tool registry and the permission registry are
    both process-global and every test that points `HERMES_HOME` somewhere new,
    or monkeypatches a declaration, adds to them — so in a shared-process run
    this fixture would see the union of everything any earlier test happened to
    register, which is not "the build" and not something this file can be
    responsible for.

    A subprocess is what the canonical runner already does per file, and it is
    the only way to ask "what does a cold start load, and does all of it have a
    tier" without the answer depending on test order.
    """
    import json
    import subprocess
    import sys

    probe = (
        "import json, model_tools;"
        "from tools.registry import registry;"
        "from hermes_cli.module_permissions import registered_permissions;"
        "print(json.dumps({'tools': registry.get_all_tool_names(),"
        " 'tiers': registered_permissions()}))"
    )
    out = subprocess.run(
        [sys.executable, "-c", probe],
        capture_output=True, text=True, timeout=300,
    )
    assert out.returncode == 0, out.stderr[-2000:]
    return json.loads(out.stdout.strip().splitlines()[-1])


class TestTheCatalogueMatchesTheBuild:
    def test_every_loaded_tool_has_a_declared_tier(self, build_surface):
        """From either source: this file, or the module that owns the tool.

        Checking only the static catalogue was wrong, and running the whole
        suite in one process is what showed it. Capability tools
        (`contact_list`, `task_advance`, …) are generated from owner-written
        declarations and declare their own tiers as they are built, so they can
        never appear in this file — the set of them is not knowable until the
        owner writes a capability.
        """
        undeclared = sorted(
            set(build_surface["tools"]) - set(build_surface["tiers"])
        )
        assert undeclared == [], (
            f"{len(undeclared)} tools fall back to the ALWAYS_APPROVAL default "
            f"instead of declaring a tier: {undeclared}"
        )

    def test_owner_declared_capability_tools_carry_their_own_tiers(self):
        """Building a capability tool is what declares its tier.

        It used to happen only in `_register()`, which runs once at import
        against whatever declarations existed then. Any later rebuild — a
        reload after a capability is authored, a profile switch — produced
        tools the permission layer had never heard of, and an unheard-of tool
        is ALWAYS_APPROVAL: safe, and unusable, because every generated *read*
        would have prompted.
        """
        from hermes_cli.module_permissions import Tier, get_tier
        from tools.capability_tools import build_tools

        generated = build_tools()
        if not generated:
            pytest.skip("no capabilities declared in this build")
        for name, _toolset, _schema, _handler, tier in generated:
            expected = Tier.AUTO if tier == "auto" else Tier.APPROVAL
            assert get_tier(name) is expected, name

    def test_the_catalogue_has_no_entries_for_tools_that_do_not_exist(
        self, build_surface
    ):
        stale = sorted(set(tool_tiers.catalogue()) - set(build_surface["tools"]))
        assert stale == [], f"declared but not registered by the build: {stale}"

    def test_no_tool_is_declared_at_two_tiers(self):
        names = list(tool_tiers.AUTO) + list(tool_tiers.APPROVAL) + list(
            tool_tiers.ALWAYS_APPROVAL
        )
        duplicates = sorted({n for n in names if names.count(n) > 1})
        assert duplicates == []


class TestTheCatalogueIsActuallyApplied:
    def test_a_lookup_sees_it_without_anyone_importing_it_first(self):
        """No import-order rule to get wrong, and no one-shot flag either.

        The first version applied the catalogue behind a "have we done this
        yet" flag, so the answer depended on whether anything had cleared the
        registry since. Running the suite in one process caught it: a reset
        left `web_search` reading as ALWAYS_APPROVAL. A tier that changes with
        what ran earlier is not a tier, so the catalogue is now consulted on
        every miss.
        """
        from hermes_cli import module_permissions

        module_permissions._reset_for_tests()
        assert get_tier("web_search") is Tier.AUTO
        # And again, to show it is not a one-shot refill either.
        module_permissions._reset_for_tests()
        assert get_tier("read_file") is Tier.AUTO

    def test_a_module_may_not_quietly_downgrade_a_catalogue_entry(self):
        """Conflicts are loud.

        `register_tool_permission` raises rather than overwriting, so a module
        declaring a tier that disagrees with this file fails at import instead
        of silently winning.
        """
        from hermes_cli.module_permissions import register_tool_permission

        get_tier("gmail_send")  # force the catalogue in
        with pytest.raises(ValueError, match="refusing to change"):
            register_tool_permission("gmail_send", Tier.AUTO)

    def test_a_tool_nobody_declared_is_still_the_strictest(self):
        # Plugins and MCP servers arrive at runtime. Completeness here must not
        # turn "unknown" into "fine".
        assert get_tier("some_plugin_tool_from_the_future") is Tier.ALWAYS_APPROVAL


class TestTheAssignmentsThatCarryTheRisk:
    """Spot checks on the lines that would matter if they were wrong."""

    @pytest.mark.parametrize(
        "name",
        [
            "gmail_send",        # sends as the owner
            "discord",
            "yb_send_dm",
            "ha_call_service",   # physical world: locks, doors, alarms
            "execute_code",      # arbitrary code
            "computer_use",
            "browser_cdp",       # arbitrary browser control
            "process",           # kills processes
            "cronjob",           # autonomy that outlives the conversation
            "skill_manage",      # installs executables
        ],
    )
    def test_it_cannot_be_pre_approved(self, name):
        assert get_tier(name) is Tier.ALWAYS_APPROVAL

    @pytest.mark.parametrize(
        "name", ["read_file", "search_files", "gmail_read", "vault_read", "web_search"]
    )
    def test_reads_do_not_prompt(self, name):
        assert get_tier(name) is Tier.AUTO

    def test_the_shell_is_gated_but_can_be_trusted(self):
        """`terminal` is APPROVAL on purpose, and the reason is load-bearing.

        It already carries the dangerous-command detector, which asks about
        `rm -rf /` and stays quiet about `git status`. This tier asks about the
        shell as a whole, once, and the per-command gate keeps firing whatever
        the owner answers — trusting the shell is not trusting every command in
        it. At ALWAYS_APPROVAL it would prompt twice for the dangerous case and
        once for every harmless one, and be switched off within a day.
        """
        from hermes_cli.module_permissions import can_be_trusted

        assert get_tier("terminal") is Tier.APPROVAL
        assert can_be_trusted("terminal") is True

    def test_an_always_approval_tool_can_never_be_trusted(self):
        from hermes_cli.module_permissions import can_be_trusted

        assert can_be_trusted("gmail_send") is False

    def test_writing_a_file_is_not_reading_one(self):
        assert get_tier("write_file") is Tier.APPROVAL
        assert get_tier("patch") is Tier.APPROVAL

    def test_drafting_is_not_sending(self):
        assert get_tier("gmail_draft") is Tier.APPROVAL
        assert get_tier("gmail_send") is Tier.ALWAYS_APPROVAL

    def test_reading_the_house_is_not_touching_the_house(self):
        assert get_tier("ha_get_state") is Tier.AUTO
        assert get_tier("ha_call_service") is Tier.ALWAYS_APPROVAL


class TestTheTierNamesTheBrokerHardcodesHaveNotDrifted:
    def test_the_always_approval_literal_still_matches_the_enum(self):
        # `execution_capability` names the strictest tier as a string so it
        # does not import the permission registry at definition time. If the
        # enum value ever changes, that guard silently stops guarding.
        from hermes_cli.execution_capability import TIER_ALWAYS_APPROVAL

        assert TIER_ALWAYS_APPROVAL == Tier.ALWAYS_APPROVAL.value
