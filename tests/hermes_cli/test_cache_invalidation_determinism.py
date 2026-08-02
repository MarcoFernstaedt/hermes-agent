"""Caches that answer the question they were asked, not a similar one.

Three invalidation keys in this codebase were derived from a file's
``(mtime_ns, size)`` or from a single directory's ``stat()``. Both are cheap
and both are wrong in a way that is silent and total: the cache serves the
previous answer as the current one, so a setting the owner just changed does
not take effect, a skill they just added does not appear, and nothing reports a
problem anywhere.

The two shapes:

*Same size, same timestamp.* Timestamp granularity is not infinite — coarse on
some filesystems, low-resolution in some containers — and a rewrite that keeps
the length is ordinary, not exotic. Editing one word of a config value produces
it routinely.

*A change below the directory that was stat'd.* A directory's mtime changes
when its own entries change and not when anything under them does, so
``skills/writing/new-skill/SKILL.md`` — the normal way a skill arrives — left
``skills/`` untouched.

The tests below force each collision explicitly rather than hoping to observe
it, because a test that waits for a coincidence is a test that passes on the
machine where the bug does not happen.
"""
from __future__ import annotations

import os

import pytest


def freeze_mtime(path, stamp_ns: int = 1_700_000_000_000_000_000) -> None:
    """Pin a file's timestamps, so two writes are indistinguishable by stat."""
    os.utime(path, ns=(stamp_ns, stamp_ns))


class TestTheConfigCache:
    @pytest.fixture
    def config_file(self, tmp_path, monkeypatch):
        from hermes_cli import config as cfg

        home = tmp_path / "home"
        home.mkdir()
        path = home / "config.yaml"
        monkeypatch.setenv("HERMES_HOME", str(home))
        monkeypatch.setattr(cfg, "get_config_path", lambda: path)
        cfg._LOAD_CONFIG_CACHE.clear()
        cfg._RAW_CONFIG_CACHE.clear()
        yield path
        cfg._LOAD_CONFIG_CACHE.clear()
        cfg._RAW_CONFIG_CACHE.clear()

    def test_a_same_size_same_timestamp_rewrite_is_seen(self, config_file):
        """The whole defect, in four lines.

        `model: aaa` and `model: bbb` are the same length. Pinning the mtime
        makes the two files identical to `(mtime_ns, size)`, so the old key
        served the first parse forever.
        """
        from hermes_cli.config import read_raw_config

        config_file.write_text("model: aaa\n", encoding="utf-8")
        freeze_mtime(config_file)
        assert read_raw_config()["model"] == "aaa"

        config_file.write_text("model: bbb\n", encoding="utf-8")
        freeze_mtime(config_file)
        assert read_raw_config()["model"] == "bbb"

    def test_the_merged_load_sees_it_too(self, config_file):
        from hermes_cli.config import load_config

        config_file.write_text("model: aaa\n", encoding="utf-8")
        freeze_mtime(config_file)
        assert load_config()["model"] == "aaa"

        config_file.write_text("model: bbb\n", encoding="utf-8")
        freeze_mtime(config_file)
        assert load_config()["model"] == "bbb"

    def test_an_unchanged_file_still_hits_the_cache(self, config_file, monkeypatch):
        # The fix must not turn the cache off. A second read of an unchanged
        # file must not re-parse.
        from hermes_cli import config as cfg

        config_file.write_text("model: aaa\n", encoding="utf-8")
        cfg.read_raw_config()

        parses: list[int] = []
        real = cfg.fast_safe_load
        monkeypatch.setattr(
            cfg, "fast_safe_load", lambda f: (parses.append(1), real(f))[1]
        )
        cfg.read_raw_config()
        cfg.read_raw_config()
        assert parses == []

    def test_a_missing_file_is_not_cached_as_content(self, config_file):
        from hermes_cli.config import read_raw_config

        assert read_raw_config() == {}
        config_file.write_text("model: aaa\n", encoding="utf-8")
        assert read_raw_config()["model"] == "aaa"

    def test_reverting_a_change_is_recognised_as_the_earlier_content(
        self, config_file
    ):
        # A content key means A → B → A lands back on the first cached parse,
        # which is correct and is the case a digest handles better than a
        # counter would.
        from hermes_cli.config import read_raw_config

        config_file.write_text("model: aaa\n", encoding="utf-8")
        freeze_mtime(config_file)
        assert read_raw_config()["model"] == "aaa"
        config_file.write_text("model: bbb\n", encoding="utf-8")
        freeze_mtime(config_file)
        assert read_raw_config()["model"] == "bbb"
        config_file.write_text("model: aaa\n", encoding="utf-8")
        freeze_mtime(config_file)
        assert read_raw_config()["model"] == "aaa"


class TestTheSkillConfigCache:
    @pytest.fixture
    def config_file(self, tmp_path, monkeypatch):
        from agent import skill_utils

        path = tmp_path / "config.yaml"
        monkeypatch.setattr(skill_utils, "get_config_path", lambda: path)
        skill_utils._raw_config_cache_clear()
        yield path
        skill_utils._raw_config_cache_clear()

    def test_a_same_size_same_timestamp_rewrite_is_seen(self, config_file):
        from agent.skill_utils import _load_raw_config

        config_file.write_text("skills:\n  disabled: [aaa]\n", encoding="utf-8")
        freeze_mtime(config_file)
        assert _load_raw_config()["skills"]["disabled"] == ["aaa"]

        config_file.write_text("skills:\n  disabled: [bbb]\n", encoding="utf-8")
        freeze_mtime(config_file)
        assert _load_raw_config()["skills"]["disabled"] == ["bbb"]

    def test_a_disabled_skill_does_not_stay_enabled(self, config_file):
        """What the stale parse actually costs, said in the domain's terms."""
        from agent.skill_utils import get_disabled_skill_names

        config_file.write_text("skills:\n  disabled: [alpha]\n", encoding="utf-8")
        freeze_mtime(config_file)
        assert "alpha" in get_disabled_skill_names()

        config_file.write_text("skills:\n  disabled: [bravo]\n", encoding="utf-8")
        freeze_mtime(config_file)
        names = get_disabled_skill_names()
        assert "bravo" in names
        assert "alpha" not in names

    def test_an_unchanged_file_is_parsed_once(self, config_file, monkeypatch):
        from agent import skill_utils

        config_file.write_text("skills:\n  disabled: [aaa]\n", encoding="utf-8")
        skill_utils._load_raw_config()

        parses: list[int] = []
        real = skill_utils.yaml_load
        monkeypatch.setattr(
            skill_utils, "yaml_load", lambda t: (parses.append(1), real(t))[1]
        )
        skill_utils._load_raw_config()
        skill_utils._load_raw_config()
        assert parses == []


class TestTheSkillsTreeFingerprint:
    def test_a_skill_added_inside_an_existing_category_is_seen(self, tmp_path):
        """The nested-addition defect.

        `skills/` itself does not change when a directory is created two levels
        below it, so a fingerprint built from its `stat()` was identical before
        and after — and the sync that depends on it never ran.
        """
        from hermes_cli.main import _directory_tree_fingerprint

        (tmp_path / "writing").mkdir()
        (tmp_path / "writing" / "existing").mkdir()
        (tmp_path / "writing" / "existing" / "SKILL.md").write_text("a")
        before = _directory_tree_fingerprint(tmp_path)

        (tmp_path / "writing" / "added").mkdir()
        (tmp_path / "writing" / "added" / "SKILL.md").write_text("b")
        assert _directory_tree_fingerprint(tmp_path) != before

    def test_the_old_top_level_stat_would_not_have_seen_it(self, tmp_path):
        # Names the reason the old key failed rather than only asserting the
        # new one works: `skills/` is genuinely unchanged.
        (tmp_path / "writing").mkdir()
        before = tmp_path.stat().st_mtime_ns
        (tmp_path / "writing" / "added").mkdir()
        (tmp_path / "writing" / "added" / "SKILL.md").write_text("b")
        assert tmp_path.stat().st_mtime_ns == before

    def test_editing_a_nested_file_is_seen(self, tmp_path):
        from hermes_cli.main import _directory_tree_fingerprint

        skill = tmp_path / "writing" / "existing"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("a")
        before = _directory_tree_fingerprint(tmp_path)
        (skill / "SKILL.md").write_text("a much longer body")
        assert _directory_tree_fingerprint(tmp_path) != before

    def test_removing_a_nested_skill_is_seen(self, tmp_path):
        from hermes_cli.main import _directory_tree_fingerprint

        skill = tmp_path / "writing" / "existing"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("a")
        before = _directory_tree_fingerprint(tmp_path)
        (skill / "SKILL.md").unlink()
        assert _directory_tree_fingerprint(tmp_path) != before

    def test_an_unchanged_tree_fingerprints_identically(self, tmp_path):
        from hermes_cli.main import _directory_tree_fingerprint

        skill = tmp_path / "writing" / "existing"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("a")
        assert _directory_tree_fingerprint(tmp_path) == _directory_tree_fingerprint(
            tmp_path
        )

    def test_a_missing_tree_is_none_rather_than_a_digest_of_nothing(self, tmp_path):
        from hermes_cli.main import _directory_tree_fingerprint

        assert _directory_tree_fingerprint(tmp_path / "absent") is None

    def test_the_bundled_skills_key_uses_the_tree(self, tmp_path, monkeypatch):
        from hermes_cli import main as hm

        skills = tmp_path / "skills" / "writing" / "existing"
        skills.mkdir(parents=True)
        (skills / "SKILL.md").write_text("a")
        monkeypatch.setattr(hm, "PROJECT_ROOT", tmp_path)
        # No git revision available, so the tree fingerprint is what is used.
        monkeypatch.setattr(hm, "_read_git_revision_fingerprint", lambda root: None)

        before = hm._termux_bundled_skills_fingerprint()
        added = tmp_path / "skills" / "writing" / "added"
        added.mkdir()
        (added / "SKILL.md").write_text("b")
        assert hm._termux_bundled_skills_fingerprint() != before
