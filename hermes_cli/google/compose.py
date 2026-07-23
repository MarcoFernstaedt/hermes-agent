"""Build RFC 2822 messages for Gmail send/draft.

Gmail's ``messages.send`` wants a base64url-encoded RFC 2822 message. Replies
must carry ``In-Reply-To`` and ``References`` headers AND be sent with the same
``threadId`` (set by the caller), or every other mail client splits the thread.
This module builds the raw message; threading headers are passed through so a
reply stitches correctly.
"""

from __future__ import annotations

import base64
from email.message import EmailMessage
from typing import List, Optional


def build_raw_message(
    *,
    to: List[str],
    subject: str,
    body: str,
    cc: Optional[List[str]] = None,
    bcc: Optional[List[str]] = None,
    from_addr: Optional[str] = None,
    in_reply_to: Optional[str] = None,
    references: Optional[str] = None,
    html_body: Optional[str] = None,
) -> str:
    """Return a base64url-encoded RFC 2822 message for Gmail send/draft.

    ``in_reply_to`` / ``references`` are the referenced message's ``Message-ID``
    header(s), required for a reply to thread correctly in every client.
    """
    msg = EmailMessage()
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    if bcc:
        msg["Bcc"] = ", ".join(bcc)
    if from_addr:
        msg["From"] = from_addr
    msg["Subject"] = subject
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        # References chains the whole ancestry; fall back to In-Reply-To.
        msg["References"] = references or in_reply_to
    elif references:
        msg["References"] = references

    msg.set_content(body or "")
    if html_body:
        msg.add_alternative(html_body, subtype="html")

    raw = msg.as_bytes()
    return base64.urlsafe_b64encode(raw).decode("ascii")
