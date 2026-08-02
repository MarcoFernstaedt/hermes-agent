"""Tests for agent.ssl_verify.resolve_httpx_verify."""

import ssl

import certifi
import pytest

from agent.ssl_verify import resolve_httpx_verify

# Every variable `resolve_httpx_verify` reads, not most of them.
# `CURL_CA_BUNDLE` is the fourth in the chain and was missing, so on any
# machine behind a TLS-inspecting proxy the resolver found a bundle and
# returned an SSLContext — and the test reported a defect in code that was
# doing exactly what it says. `test_ssl_ca_guard.py` already had the full
# list; this one had drifted.
_CA_ENV_VARS = (
    "HERMES_CA_BUNDLE", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
)


@pytest.fixture
def clean_ca_env(monkeypatch):
    for var in _CA_ENV_VARS:
        monkeypatch.delenv(var, raising=False)


def test_ssl_verify_false_disables_verification(clean_ca_env):
    assert resolve_httpx_verify(ssl_verify=False) is False


def test_hermes_ca_bundle_returns_ssl_context(clean_ca_env, monkeypatch):
    monkeypatch.setenv("HERMES_CA_BUNDLE", certifi.where())
    result = resolve_httpx_verify()
    assert isinstance(result, ssl.SSLContext)


def test_explicit_ca_bundle_param(clean_ca_env):
    result = resolve_httpx_verify(ca_bundle=certifi.where())
    assert isinstance(result, ssl.SSLContext)


def test_missing_ca_bundle_falls_back_to_true(clean_ca_env, monkeypatch):
    monkeypatch.setenv("HERMES_CA_BUNDLE", "/nonexistent/root-ca.pem")
    assert resolve_httpx_verify() is True


def test_default_without_env_is_true(clean_ca_env):
    assert resolve_httpx_verify() is True
