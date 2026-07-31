"""`gmail_send` — the one tool in this codebase that puts mail on the wire.

Separated from `tools/gmail_tools.py` deliberately. That module's docstring
opens by describing itself as "the SAFE surface (search, read, draft)" and says
sending "requires an interactive approval prompt wired into the agent dispatch
(ALWAYS_APPROVAL, never auto)". Keeping send in its own file preserves that
boundary as a fact about the code rather than a claim in a comment: nothing can
casually widen the safe module by adding one more entry to its tuple.

Design constraints, each of which exists because sending is irreversible:

**The sender is not an argument.** It is resolved from the authenticated
mailbox at call time. A model that could name its own `from` address could
impersonate; a model that cannot, cannot.

**Recipients are resolved and frozen before approval.** The approval payload
carries the exact final recipient list and a hash over the whole message. If
anything about the message changes after the owner looked at it, the hash
changes, and the send that was approved is not the send being attempted.

**Idempotency covers the send, not the request.** The key is derived from
sender, recipients, subject and body, so an approved send retried after a
timeout or a reconnect resolves to the same key and cannot go out twice. A
genuinely different message hashes differently and is allowed through.

**v1 is narrow on purpose.** No CC, BCC, attachments, reply-all, alias senders,
or HTML. Unsupported fields are *rejected* rather than ignored — silently
dropping a `bcc` the model asked for would mean the owner approved a card that
did not describe what was sent.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, List

from tools.registry import registry, tool_error, tool_result

#: Body text beyond this is truncated *for the approval preview only*. The
#: message itself is never altered — the owner is told the preview is bounded.
_PREVIEW_CHARS = 800

#: Fields a caller might reasonably expect to work, which v1 does not support.
#: Rejected loudly, because the approval card must describe the real send.
_UNSUPPORTED = ("cc", "bcc", "attachments", "html", "from", "sender", "reply_all")


def _as_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    if isinstance(value, (list, tuple)):
        return [str(v).strip() for v in value if str(v).strip()]
    return []


def _gmail_available() -> bool:
    try:
        from hermes_cli import secure_store

        tok = secure_store.load_token("google", "default")
        if tok is None:
            return False
        return secure_store.get_status("google", "default") != secure_store.STATUS_NEEDS_REAUTH
    except Exception:
        return False


def _resolve_sender() -> str:
    """The authenticated mailbox address. Never taken from arguments."""
    from hermes_cli.google.gmail import GmailClient

    profile = GmailClient().get_profile()
    address = str((profile or {}).get("emailAddress") or "").strip()
    if not address:
        raise RuntimeError("could not resolve the authenticated sender address")
    return address


def send_fingerprint(*, sender: str, to: List[str], subject: str, body: str) -> str:
    """Stable hash over everything that determines what actually gets sent.

    Recipients are sorted so that reordering the same audience is recognised as
    the same message, but any change to who receives it, what it says, or who it
    claims to be from produces a different fingerprint — which invalidates a
    stale approval rather than letting it authorise a different email.
    """
    payload = json.dumps(
        {
            "sender": sender.strip().lower(),
            "to": sorted(a.strip().lower() for a in to),
            "subject": subject.strip(),
            "body": body,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def build_approval_preview(
    *, sender: str, to: List[str], subject: str, body: str
) -> dict[str, Any]:
    """Exactly what the approval card shows. Nothing here is optional.

    The owner must be able to see who it comes from, everyone who receives it,
    the subject, and enough of the body to judge it — and must be told when the
    preview is shorter than the message.
    """
    truncated = len(body) > _PREVIEW_CHARS
    return {
        "from": sender,
        "to": list(to),
        "recipient_count": len(to),
        "subject": subject,
        "body_preview": body[:_PREVIEW_CHARS],
        "body_truncated": truncated,
        "body_length": len(body),
        "fingerprint": send_fingerprint(sender=sender, to=to, subject=subject, body=body),
        "irreversible": True,
        "consequence": (
            f"Sends this email from {sender} to "
            f"{', '.join(to) if len(to) <= 3 else f'{len(to)} recipients'}. "
            "A sent message cannot be recalled."
        ),
    }


def _handle_gmail_send(args: dict, **_kw) -> str:
    from hermes_cli.actions.idempotency import IdempotencyStore
    from hermes_cli.google.compose import build_raw_message
    from hermes_cli.google.gmail import GmailClient
    from hermes_constants import get_hermes_home

    # Reject rather than ignore. A dropped bcc would mean the owner approved a
    # card that did not describe the message that went out.
    present = [f for f in _UNSUPPORTED if args.get(f) not in (None, "", [], {})]
    if present:
        return tool_error(
            f"gmail_send does not support {', '.join(present)} yet. "
            "Use gmail_draft and send it yourself if you need them."
        )

    to = _as_list(args.get("to"))
    if not to:
        return tool_error("to is required (one or more recipients)")
    subject = str(args.get("subject") or "").strip()
    if not subject:
        return tool_error("subject is required")
    body = str(args.get("body") or "")
    if not body.strip():
        return tool_error("body is required")

    try:
        sender = _resolve_sender()
    except Exception as exc:
        # Fail closed: without a verified sender there is no honest approval
        # card to render, so nothing may be sent.
        return tool_error(f"cannot send: {exc}")

    fingerprint = send_fingerprint(sender=sender, to=to, subject=subject, body=body)
    store = IdempotencyStore(get_hermes_home() / "state" / "idempotency.sqlite3")
    key = f"gmail_send:{fingerprint}"

    won, prior = store.claim(key)
    if not won:
        # Already sent, or in flight. Report the original outcome instead of
        # sending again — this is the retry-after-reconnect path.
        if prior and prior.get("state") == "succeeded":
            return tool_result({
                "sent": True,
                "duplicate_suppressed": True,
                "message_id": (prior.get("result") or {}).get("message_id"),
                "note": "This exact message was already sent; not sent again.",
            })
        return tool_error(
            "an identical send is already in flight; not sending a second copy"
        )

    # Won the claim, but possibly by reacquiring a failed attempt. Suppressing a
    # *successful* send is the point of the key; suppressing a failed one would
    # mean nothing went out and the owner cannot send that exact message until
    # the key expires. The retry is allowed and is labelled as one, because a
    # send that raised is not proof nothing was delivered — a timeout after
    # delivery looks identical from here, and only the owner can judge that.
    retry_of: dict[str, Any] | None = (
        prior if prior and prior.get("state") == "failed" else None
    )

    try:
        raw = build_raw_message(to=to, subject=subject, body=body)
        result = GmailClient().send_message(raw)
        message_id = str((result or {}).get("id") or "")
        store.settle(key, state="succeeded", result={"message_id": message_id})
    except Exception as exc:
        # A failed send must not leave a claim that blocks a legitimate retry,
        # but it must also be recorded — a later duplicate should be able to see
        # that the first attempt failed rather than assume it is the first.
        store.settle(key, state="failed", result={"error": str(exc)})
        _audit("send.failed", target=", ".join(to), detail={"subject": subject})
        return tool_error(f"send failed: {exc}")

    # Counts and identifiers only — never the body, never a recipient's content.
    _audit(
        "send",
        target=f"{len(to)} recipient(s)",
        detail={"subject": subject, "fingerprint": fingerprint[:16]},
    )
    payload: dict[str, Any] = {
        "sent": True,
        "message_id": message_id,
        "from": sender,
        "recipient_count": len(to),
        "note": "Sent. This cannot be undone.",
    }
    if retry_of is not None:
        payload["retry_after_failed_attempt"] = True
        payload["previous_error"] = str((retry_of.get("result") or {}).get("error") or "")
        payload["note"] = (
            "Sent. This cannot be undone. An earlier attempt at this exact "
            "message failed; if that failure happened after delivery, the "
            "recipient may now have two copies."
        )
    return tool_result(payload)


def _audit(action: str, *, target: str, detail: dict) -> None:
    try:
        from hermes_cli import audit_log

        audit_log.record(
            actor="agent", module="gmail", tool="gmail_send",
            action=action, outcome="ok", target=target, detail=detail,
        )
    except Exception:
        pass


_SCHEMA = {
    "name": "gmail_send",
    "description": (
        "Send an email from the owner's authenticated mailbox. IRREVERSIBLE — a "
        "sent message cannot be recalled, and every send requires the owner's "
        "explicit approval of that exact message. The sender address is resolved "
        "from the authenticated account and cannot be set. No CC, BCC, "
        "attachments or HTML: use gmail_draft for anything this does not cover."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "to": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Recipient email addresses.",
            },
            "subject": {"type": "string"},
            "body": {"type": "string", "description": "Plain text. HTML is not supported."},
        },
        "required": ["to", "subject", "body"],
    },
}


def _register_permissions() -> None:
    try:
        from hermes_cli.module_permissions import Tier, register_tool_permission

        # ALWAYS_APPROVAL, not APPROVAL — deliberately stricter than the review
        # asked for, because APPROVAL is *trustable*: `can_be_trusted()` returns
        # True for it, so the settings UI would be entitled to offer gmail_send
        # an auto-approve toggle, and one click would let the agent send any
        # mail unprompted for the rest of a session. That directly contradicts
        # the requirement that no send happens without an exact approval of that
        # message. ALWAYS_APPROVAL is non-negotiable at the resolver and cannot
        # be added to the trusted set at all.
        register_tool_permission("gmail_send", Tier.ALWAYS_APPROVAL)
    except Exception:
        pass


_register_permissions()

registry.register(name="gmail_send", toolset="gmail",
                  schema=_SCHEMA, handler=_handle_gmail_send,
                  check_fn=_gmail_available, emoji="")
