"""Tests for the Gmail MIME compose builder."""

import base64
from email import message_from_bytes
from email.policy import default as default_policy

from hermes_cli.google.compose import build_raw_message


def _decode(raw: str):
    return message_from_bytes(base64.urlsafe_b64decode(raw), policy=default_policy)


def test_basic_message():
    raw = build_raw_message(to=["a@x.com"], subject="Hi", body="Hello there")
    msg = _decode(raw)
    assert msg["To"] == "a@x.com"
    assert msg["Subject"] == "Hi"
    assert "Hello there" in msg.get_content()


def test_reply_sets_threading_headers():
    raw = build_raw_message(
        to=["a@x.com"],
        subject="Re: Hi",
        body="thanks",
        in_reply_to="<abc@mail.gmail.com>",
    )
    msg = _decode(raw)
    assert msg["In-Reply-To"] == "<abc@mail.gmail.com>"
    # References falls back to In-Reply-To when not supplied.
    assert msg["References"] == "<abc@mail.gmail.com>"


def test_cc_and_html_alternative():
    raw = build_raw_message(
        to=["a@x.com"],
        cc=["b@x.com"],
        subject="S",
        body="plain",
        html_body="<p>rich</p>",
    )
    msg = _decode(raw)
    assert msg["Cc"] == "b@x.com"
    assert msg.is_multipart()
    types = {p.get_content_type() for p in msg.walk()}
    assert "text/plain" in types
    assert "text/html" in types
