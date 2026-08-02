"""The voice card must describe the voice path that actually runs.

The defect these tests exist for is not "a field was wrong". It is that the
status adapter re-derived the answer from environment variables while the
runtime resolved it from config — so the two drifted, and the card confidently
described a machine that did not exist. Every test here pins the card to
`tools.transcription_tools` / `tools.tts_tool`, and the privacy tests are the
ones that matter most: telling an owner their dictation stays local when it is
being uploaded is the worst thing this surface can do.
"""
from __future__ import annotations

import pytest

from hermes_cli.capability_adapters import resolved_stt, resolved_tts, voice_status


@pytest.fixture
def stt_config(monkeypatch):
    """Set the STT config the runtime resolver reads."""

    def set_config(config: dict):
        monkeypatch.setattr(
            "tools.transcription_tools._load_stt_config", lambda: config
        )

    return set_config


@pytest.fixture
def tts_config(monkeypatch):
    def set_config(config: dict):
        monkeypatch.setattr("tools.tts_tool._load_tts_config", lambda: config)

    return set_config


@pytest.fixture(autouse=True)
def _no_local_whisper(monkeypatch):
    """Default to a machine with no local transcription available.

    Each test then turns on exactly the thing it is about, so nothing passes
    because of what happens to be installed in the test environment.
    """
    monkeypatch.setattr("tools.transcription_tools._HAS_FASTER_WHISPER", False)
    monkeypatch.setattr("tools.transcription_tools._has_local_command", lambda: False)
    # Resolving must never install anything; if this fires, the adapter asked
    # for a side effect while rendering a status card.
    monkeypatch.setattr(
        "tools.transcription_tools._try_lazy_install_stt",
        lambda: pytest.fail("the status adapter triggered a lazy install"),
    )
    for key in (
        "GROQ_API_KEY", "OPENAI_API_KEY", "VOICE_TOOLS_OPENAI_KEY",
        "MISTRAL_API_KEY", "XAI_API_KEY", "ELEVENLABS_API_KEY",
        "DEEPINFRA_API_KEY",
    ):
        monkeypatch.delenv(key, raising=False)


def notes(status) -> str:
    return " ".join(status.notes)


class TestItAsksTheRuntimeRatherThanGuessing:
    def test_a_disabled_stt_config_is_reported_as_disabled(self, stt_config, tts_config):
        """`stt.enabled: false` was invisible to the old adapter.

        A deliberately switched-off microphone surface reported as working,
        because the check was "is faster_whisper importable".
        """
        stt_config({"enabled": False})
        tts_config({"provider": "piper"})

        assert resolved_stt()["available"] is False
        status = voice_status()
        assert status.configured is False
        assert "stt.enabled: false" in status.detail
        assert "config.yaml" in status.next_action

    def test_an_explicit_provider_is_not_silently_replaced_by_the_local_model(
        self, stt_config, tts_config, monkeypatch
    ):
        """Pinned to Groq with no key: nothing transcribes, even with a local
        model installed. The runtime refuses to substitute; the card must say
        the same thing rather than reporting local transcription."""
        monkeypatch.setattr("tools.transcription_tools._HAS_FASTER_WHISPER", True)
        stt_config({"provider": "groq"})
        tts_config({"provider": "piper"})

        resolved = resolved_stt()
        assert resolved["available"] is False
        assert resolved["requested"] == "groq"

        status = voice_status()
        assert "groq" in status.detail
        assert "local model is deliberately not substituted" in status.detail
        assert "GROQ_API_KEY" in status.next_action
        assert "runs locally" not in notes(status)

    def test_a_command_provider_is_seen_at_all(self, stt_config, tts_config):
        """A working `stt.providers.<name>` setup used to report "nothing can
        transcribe", because the old check only knew about env keys."""
        stt_config({
            "provider": "my-whisper",
            "providers": {
                "my-whisper": {"type": "command", "command": "whisper {input_path}"},
            },
        })
        tts_config({"provider": "piper"})

        assert resolved_stt()["available"] is True
        assert voice_status().configured is True

    def test_a_credential_alone_is_not_a_claim_that_it_runs(
        self, stt_config, tts_config, monkeypatch
    ):
        """A key for a provider the config did not choose changes nothing.

        The old adapter listed every provider whose credential happened to be
        set, which is a different claim from "this is what transcribes".
        """
        monkeypatch.setenv("ELEVENLABS_API_KEY", "sk-test")
        stt_config({"provider": "groq"})
        tts_config({"provider": "piper"})

        assert resolved_stt()["available"] is False
        assert "elevenlabs" not in notes(voice_status())


class TestPrivacyIsReportedFromTheProviderThatWouldRun:
    def test_a_local_provider_is_reported_as_local(
        self, stt_config, tts_config, monkeypatch
    ):
        monkeypatch.setattr("tools.transcription_tools._HAS_FASTER_WHISPER", True)
        stt_config({"provider": "local"})
        tts_config({"provider": "piper"})

        assert resolved_stt()["privacy"] == "local"
        text = notes(voice_status())
        assert "does not leave this machine" in text
        # And with a local speech provider too, nothing claims anything leaves.
        assert "leaves this machine" not in text.replace(
            "does not leave this machine", ""
        )

    @pytest.mark.parametrize(
        "provider,env",
        [
            ("groq", "GROQ_API_KEY"),
            ("openai", "OPENAI_API_KEY"),
            ("elevenlabs", "ELEVENLABS_API_KEY"),
            ("deepinfra", "DEEPINFRA_API_KEY"),
        ],
    )
    def test_a_remote_provider_is_never_reported_as_local(
        self, stt_config, tts_config, monkeypatch, provider, env
    ):
        """The single worst thing this card can do.

        A local model installed alongside a configured cloud provider used to
        produce "Transcription runs locally" while every recording was being
        uploaded.
        """
        monkeypatch.setattr("tools.transcription_tools._HAS_FASTER_WHISPER", True)
        monkeypatch.setattr("tools.transcription_tools._HAS_OPENAI", True)
        monkeypatch.setattr(
            "tools.transcription_tools._has_openai_audio_backend", lambda: True
        )
        monkeypatch.setenv(env, "sk-test")
        stt_config({"provider": provider})
        tts_config({"provider": "piper"})

        assert resolved_stt()["privacy"] == "remote"
        text = notes(voice_status())
        assert "does not leave this machine" not in text
        assert "runs locally" not in text
        assert provider in text

    def test_a_command_provider_destination_is_not_claimed_to_be_local(
        self, stt_config, tts_config
    ):
        """A declared command is as likely to be `curl` to a hosted API as it
        is to be a local binary. "Launched locally" is not "stays local"."""
        stt_config({
            "provider": "mystery",
            "providers": {
                "mystery": {"type": "command", "command": "curl -F f=@{input_path} https://api.example/asr"},
            },
        })
        tts_config({"provider": "piper"})

        assert resolved_stt()["privacy"] == "unknown"
        text = notes(voice_status())
        assert "cannot determine" in text
        assert "does not leave this machine" not in text

    def test_a_remote_speech_provider_is_reported_as_remote(
        self, stt_config, tts_config, monkeypatch
    ):
        monkeypatch.setattr("tools.transcription_tools._HAS_FASTER_WHISPER", True)
        stt_config({"provider": "local"})
        tts_config({"provider": "elevenlabs"})

        assert resolved_tts()["privacy"] == "remote"
        assert "reply text leaves this machine" in notes(voice_status())

    def test_the_default_speech_provider_is_remote_and_is_said_to_be(
        self, stt_config, tts_config, monkeypatch
    ):
        # An empty tts config resolves to `edge`, which is Microsoft's.
        monkeypatch.setattr("tools.transcription_tools._HAS_FASTER_WHISPER", True)
        stt_config({"provider": "local"})
        tts_config({})

        assert resolved_tts() == {
            "provider": "edge", "kind": "builtin", "privacy": "remote"
        }
        assert "reply text leaves this machine" in notes(voice_status())

    def test_an_unrecognised_speech_provider_reports_the_fallback_not_the_typo(
        self, stt_config, tts_config, monkeypatch
    ):
        """`text_to_speech_tool` falls through to Edge for an unknown name.

        Echoing the misspelling back as "a provider whose destination cannot
        be determined" would understate what happens: the reply text goes to
        Microsoft, and the card has to say so.
        """
        monkeypatch.setattr("tools.transcription_tools._HAS_FASTER_WHISPER", True)
        monkeypatch.setattr(
            "hermes_cli.capability_adapters._tts_plugin_registered", lambda p: False
        )
        stt_config({"provider": "local"})
        tts_config({"provider": "elevenlab"})  # typo

        assert resolved_tts() == {
            "provider": "edge", "kind": "builtin", "privacy": "remote"
        }
        assert "reply text leaves this machine" in notes(voice_status())

    def test_a_registered_plugin_provider_is_reported_as_undetermined(
        self, stt_config, tts_config, monkeypatch
    ):
        monkeypatch.setattr("tools.transcription_tools._HAS_FASTER_WHISPER", True)
        monkeypatch.setattr(
            "hermes_cli.capability_adapters._tts_plugin_registered", lambda p: True
        )
        stt_config({"provider": "local"})
        tts_config({"provider": "my-plugin"})

        assert resolved_tts() == {
            "provider": "my-plugin", "kind": "plugin", "privacy": "unknown"
        }
        assert "cannot determine" in notes(voice_status())


class TestTheCaptureClaimsAreUnconditional:
    def test_push_to_talk_and_no_retention_are_always_stated(
        self, stt_config, tts_config
    ):
        # These are facts about the page, not about the provider, so they hold
        # even on a machine where nothing can transcribe.
        stt_config({})
        tts_config({})
        text = notes(voice_status())
        assert "Nothing listens between presses." in text
        assert "Audio is not retained after transcription." in text


class TestResolvingIsSideEffectFree:
    def test_the_card_never_installs_anything(self, stt_config, tts_config):
        # The autouse fixture fails the test if the lazy installer fires. This
        # names the guarantee explicitly: rendering a status page must not
        # install a package.
        stt_config({})
        tts_config({})
        voice_status()

    def test_the_runtime_path_keeps_its_lazy_install(self, monkeypatch):
        """`allow_install=False` is the status adapter's flag, not a change to
        how transcription behaves."""
        from tools import transcription_tools as stt_tools

        installed: list[bool] = []

        def fake_install():
            installed.append(True)
            return False

        monkeypatch.setattr(stt_tools, "_HAS_FASTER_WHISPER", False)
        monkeypatch.setattr(stt_tools, "_has_local_command", lambda: False)
        monkeypatch.setattr(stt_tools, "_try_lazy_install_stt", fake_install)

        stt_tools._get_provider({"provider": "local"})
        assert installed == [True]

        installed.clear()
        stt_tools._get_provider({"provider": "local"}, allow_install=False)
        assert installed == []
