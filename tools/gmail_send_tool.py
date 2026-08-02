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


def rfc_message_id(fingerprint: str) -> str:
    """A deterministic RFC 5322 Message-ID for this exact message.

    Broker-controlled and derived from the fingerprint, so after an ambiguous
    outcome the question "did this send?" is answerable by looking for one id
    in the Sent folder rather than by comparing bodies and hoping.
    """
    return f"<{fingerprint[:32]}.imperator@localhost>"


#: The shape of a Gmail message id. Gmail returns an opaque URL-safe token —
#: in practice lowercase hex, historically 16 characters, but the API documents
#: only "an immutable ID". The check below is therefore a *shape* check, not a
#: format claim: it establishes that the provider returned an identifier rather
#: than something an identifier could be coerced out of.
_PROVIDER_ID_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
)
_PROVIDER_ID_MIN = 6
_PROVIDER_ID_MAX = 256


def valid_provider_message_id(value: Any) -> str:
    """The provider's message id, or "" when what came back is not one.

    This exists because `str(result.get("id") or "")` accepted anything that
    was not falsy. A `{"id": {"nested": 1}}` became the string
    ``"{'nested': 1}"``; a `{"id": True}` became ``"True"``; a `{"id": 1}`
    became ``"1"``. Each of those is non-empty, so each was reported to the
    owner as a confirmed send and written to the idempotency row as proof —
    a claim of delivery resting on a value the provider never issued.

    Only a `str` is considered. Coercing is the bug: an `int` id is not a
    Gmail id that needs converting, it is a response that does not match the
    contract, and the honest reading of a response that does not match the
    contract is that the outcome is unknown.
    """
    if not isinstance(value, str):
        return ""
    candidate = value.strip()
    if not (_PROVIDER_ID_MIN <= len(candidate) <= _PROVIDER_ID_MAX):
        return ""
    if not set(candidate) <= _PROVIDER_ID_CHARS:
        return ""
    return candidate


#: Kinds of evidence that a message was *not* delivered, strong enough to make
#: an ambiguous send sendable again. Each one is a positive statement by an
#: authority, not the absence of a statement.
NON_DELIVERY_PROOF_KINDS = frozenset({
    # The owner looked in Sent themselves and says it is not there. The owner
    # is the authority on their own mailbox; nothing else in this list is
    # available without one.
    "owner_confirmed",
    # The provider rejected the message permanently: a 5xx SMTP/`permanentFailure`
    # status or a bounce naming this Message-ID. The provider stating that it
    # did not deliver is different in kind from a search not finding it.
    "provider_permanent_failure",
})


#: Provider diagnostics can echo recipients, subjects, or fragments of the
#: message. Durable records get a bounded, shape-only summary instead.
_ERROR_LIMIT = 120


def _safe_error(exc: Exception, scrub: Any = ()) -> str:
    """The exception's *type* and a bounded, scrubbed excerpt.

    A raw provider error is a durable record of whatever the provider chose to
    quote back, which for a mail API is often the recipients and the subject.
    Bounding the length was never enough for that: a 550 rejection quotes the
    recipient and the subject inside the first sixty characters, and the row it
    lands in outlives the message.

    ``scrub`` is the concrete strings this send is *known* to contain — the
    sender, the recipients, the subject. They are removed by value rather than
    by pattern, which is the only reliable way: there is no regex for "this
    particular subject line". Credentials that wandered into the diagnostic go
    through the shared redactor on top.
    """
    text = str(exc).replace("\n", " ").strip()
    if not text:
        return type(exc).__name__

    # Longest first, so removing a recipient does not leave the domain behind
    # when the address also appears inside a longer quoted string.
    for secret in sorted(
        {str(s).strip() for s in (scrub or ()) if str(s).strip()},
        key=len, reverse=True,
    ):
        text = text.replace(secret, "[redacted]")

    try:
        from agent.redact import redact_sensitive_text

        text = redact_sensitive_text(text)
    except Exception:  # pragma: no cover - defensive
        pass

    return f"{type(exc).__name__}: {text[:_ERROR_LIMIT]}"


def _require_owner_approval(
    *,
    preview: dict[str, Any],
    fingerprint: str,
    recipient_count: int,
    subject: str,
    retrying: bool = False,
) -> dict[str, Any]:
    """Block until the owner approves this exact message, or refuse.

    Imported at call time so a failure to import the approval machinery cannot
    be answered by sending anyway — an ImportError here becomes a refusal, not
    an ungated send.
    """
    reason = (
        f"Send an email from {preview['from']} to {recipient_count} "
        f"recipient(s), subject {subject!r}. This cannot be undone."
    )
    if retrying:
        reason += (
            " An earlier attempt at this exact message failed without a "
            "confirmed outcome; if it failed after delivery, this would be a "
            "second copy."
        )
    try:
        from tools.approval import request_tool_approval

        return request_tool_approval(
            "gmail_send",
            reason,
            # The message itself is the grain. Any change to who it is from,
            # who receives it, or what it says produces a different key — so
            # one approval can never authorise a different email.
            rule_key=f"gmail_send:{fingerprint}",
            preview=preview,
            once_only=True,
        )
    except Exception as exc:  # pragma: no cover - defensive
        return {
            "approved": False,
            "message": f"cannot ask for approval, so nothing is sent: {exc}",
        }


def reconcile_ambiguous_send(
    *, fingerprint: str, search=None, store=None, proof: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Answer "did that actually send?" by looking, not by waiting.

    An ambiguous outcome blocks forever without this — which is correct while
    the answer is unknown and useless once it is knowable. The deterministic
    RFC Message-ID is what makes it knowable: it either appears in Sent or it
    does not, and no content comparison is involved.

    The two directions are not symmetric, and treating them as if they were
    was the defect this signature exists to fix. **Finding** the message is
    proof it was delivered: the id is broker-controlled, so nothing else could
    have put it there. **Not finding** it is not proof of anything. Gmail's
    `rfc822msgid:` index is eventually consistent and routinely lags a send by
    seconds to minutes; a throttled or partially-served query returns an empty
    page; a filter or a rule can move a message out of `SENT`. Settling
    `failed` on that emptiness marks the message sendable again — and the case
    where it is wrong is exactly the case that matters, because the message
    already went out and the owner sends a second copy.

    So a negative search leaves the row `ambiguous`. Clearing it requires
    ``proof``: a dict with a ``kind`` from `NON_DELIVERY_PROOF_KINDS` and an
    ``actor`` naming who or what is making the claim. That is the owner having
    looked, or the provider having said it failed permanently — a positive
    statement by an authority, rather than a question that returned nothing.

    Idempotent and owner-fenced. Reconciliation claims the row the same way a
    send does, so two reconcilers cannot both settle it, and a terminal row is
    left exactly as it was rather than re-decided.
    """
    from hermes_cli.actions.idempotency import IdempotencyStore
    from hermes_constants import get_hermes_home

    if store is None:
        store = IdempotencyStore(get_hermes_home() / "state" / "idempotency.sqlite3")
    key = f"gmail_send:{fingerprint}"
    rfc_id = rfc_message_id(fingerprint)

    record = store.lookup(key)
    if record is None:
        return {"reconciled": False, "reason": "no record for that message"}
    if record["state"] != "ambiguous":
        # Already terminal. Re-deciding a settled outcome is how a second
        # reconciler undoes the first one's answer.
        return {"reconciled": False, "state": record["state"],
                "reason": "not ambiguous; nothing to reconcile"}

    if search is None:
        def search(message_id: str) -> Optional[str]:
            from hermes_cli.google.gmail import GmailClient

            # `rfc822msgid:` is Gmail's own index on the Message-ID header,
            # which is exactly the field we set deterministically before
            # dispatch — so this is a lookup, not a content search.
            found = GmailClient().list_messages(
                q=f"rfc822msgid:{message_id}", label_ids=["SENT"], max_results=1
            )
            for hit in (found or {}).get("messages") or []:
                got = str((hit or {}).get("id") or "")
                if got:
                    return got
            return None

    try:
        found = search(rfc_id)
    except Exception as exc:
        # Could not look. Still ambiguous — an unreachable provider is not
        # evidence either way.
        return {"reconciled": False, "state": "ambiguous",
                "reason": f"could not search: {_safe_error(exc)}"}

    # The same shape check the send path applies. A search that returns a dict,
    # a list, a bool or a number has not found a message; it has returned
    # something a message id could be coerced out of, and coercing it here
    # would settle the row `succeeded` on the strength of a malformed reply.
    provider_id = valid_provider_message_id(found)
    if found not in (None, "", [], {}) and not provider_id:
        return {
            "reconciled": False,
            "state": "ambiguous",
            "reason": "the Sent search returned a malformed result; the outcome "
                      "is still unknown",
        }

    accepted_proof = _accepted_non_delivery_proof(proof)
    if not provider_id and accepted_proof is None:
        # The important half of this function. See the docstring: an empty
        # search result is a question that returned nothing, not an answer.
        return {
            "reconciled": False,
            "state": "ambiguous",
            "reason": (
                "not found in Sent, which is not proof it was not delivered — "
                "Gmail's message-id index lags a send and a throttled query "
                "returns nothing. Check the Sent folder yourself, then "
                "reconcile with proof of non-delivery."
            ),
            "rfc_message_id": rfc_id,
            "needs": sorted(NON_DELIVERY_PROOF_KINDS),
        }

    # Take ownership before writing, so two reconcilers cannot both settle.
    owner = store.adopt_ambiguous(key)
    if owner is None:
        return {"reconciled": False, "reason": "another reconciliation is in progress"}

    if provider_id:
        store.settle_dispatched(
            key, owner, state="succeeded",
            result={"message_id": provider_id, "rfc_message_id": rfc_id,
                    "reconciled": True},
        )
        _audit("send.reconciled", target="1 message",
               detail={"fingerprint": fingerprint[:16], "outcome": "delivered"})
        return {"reconciled": True, "state": "succeeded", "message_id": provider_id}

    # An authority stated it did not land, so the message becomes sendable
    # again — and the audit row records who said so, because this is the write
    # that permits a second copy of an irreversible action.
    store.settle_reconciled(
        key, owner, state="failed",
        result={"error": "confirmed not delivered",
                "proof_kind": accepted_proof["kind"],
                "proof_actor": accepted_proof["actor"],
                "rfc_message_id": rfc_id},
    )
    _audit("send.reconciled", target="1 message",
           detail={"fingerprint": fingerprint[:16], "outcome": "not_delivered",
                   "proof_kind": accepted_proof["kind"],
                   "proof_actor": accepted_proof["actor"]})
    return {"reconciled": True, "state": "failed",
            "proof_kind": accepted_proof["kind"],
            "note": "confirmed not delivered; this message can be sent again"}


def _accepted_non_delivery_proof(proof: Any) -> dict[str, str] | None:
    """Validate an offered proof of non-delivery, or None if it is not one.

    Deliberately strict, and deliberately not a truthiness check: the effect of
    accepting this is that an irreversible action becomes repeatable. An
    unattributed claim is refused because a grant nobody can be traced to
    cannot be reviewed afterwards, which is the same rule the capability
    approver identity follows.
    """
    if not isinstance(proof, dict):
        return None
    kind = proof.get("kind")
    actor = proof.get("actor")
    if not isinstance(kind, str) or kind not in NON_DELIVERY_PROOF_KINDS:
        return None
    if not isinstance(actor, str) or not actor.strip():
        return None
    return {"kind": kind, "actor": actor.strip()}


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

    # Everything about this message that must not survive into a durable error
    # record. A 550 rejection quotes the recipient and the subject back, and
    # bounding the excerpt does not help when both appear in the first sixty
    # characters. These are removed by value, because there is no pattern for
    # "this particular subject line".
    scrub: tuple[str, ...] = (sender, subject, *to)

    won, prior, attempt = store.claim(key)
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
        if prior and prior.get("state") == "ambiguous":
            # The dangerous one. An earlier attempt reached the point of no
            # return and never came back with an answer, so the message may
            # already be in the recipient's inbox. Time does not resolve that,
            # and a "retry" here is how one send becomes two.
            return tool_error(
                "an earlier attempt at this exact message was interrupted after "
                "it had been handed to Gmail, so it may already have been "
                "delivered. Check the Sent folder before sending again; this "
                "will not send until that is reconciled."
            )
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

    # The human gate. Registering ALWAYS_APPROVAL records a tier; nothing in
    # the dispatch path turned that tier into a gate, so the strictest label in
    # the system had no bearing on whether mail went out. It does now, and it
    # is asked *after* the idempotency claim so a duplicate that is not about
    # to happen never interrupts the owner.
    #
    # Keyed on the fingerprint: an approval authorises exactly the message the
    # owner read, and any change to sender, recipients, subject or body is a
    # different key and a fresh ask. `once_only` refuses the session cache,
    # `--yolo` and `cron_mode: approve` — an irreversible send that can be
    # pre-approved is an APPROVAL-tier action wearing a stricter label.
    approval = _require_owner_approval(
        preview=build_approval_preview(
            sender=sender, to=to, subject=subject, body=body
        ),
        fingerprint=fingerprint,
        recipient_count=len(to),
        subject=subject,
        retrying=retry_of is not None,
    )
    if not approval.get("approved"):
        # Release, don't settle: nothing was sent, so a later approved attempt
        # is a first attempt and must not be mistaken for a duplicate.
        store.release(key, attempt)
        _audit("send.denied", target=f"{len(to)} recipient(s)",
               detail={"fingerprint": fingerprint[:16]})
        return tool_error(
            approval.get("message") or "The owner did not approve this send."
        )

    # Everything before the request leaves is *provably* not-sent, so a failure
    # here is `failed` and retryable. Building the MIME message is in that
    # bracket; handing it to Gmail is not.
    try:
        raw = build_raw_message(
            to=to, subject=subject, body=body,
            # A broker-controlled Message-ID is what makes reconciliation
            # possible: after an ambiguous outcome, this exact id either
            # appears in the Sent folder or it does not, and no content
            # comparison is needed to tell.
            message_id=rfc_message_id(fingerprint),
        )
    except Exception as exc:
        store.settle_pre_dispatch(
            key, attempt, result={"error": _safe_error(exc, scrub)}
        )
        _audit("send.failed", target=f"{len(to)} recipient(s)",
               detail={"stage": "compose", "fingerprint": fingerprint[:16]})
        return tool_error(
            f"send failed before anything was sent: {_safe_error(exc, scrub)}"
        )

    # Past this line an unexplained failure is ambiguous, not failed: a
    # provider that accepted the message and then dropped the response looks
    # exactly like one that never received it.
    if not store.mark_dispatching(key, attempt):
        return tool_error("this send was taken over by another attempt; not sending")

    try:
        result = GmailClient().send_message(raw)
        # `valid_provider_message_id`, not `str(... or "")`. Coercion made a
        # dict, a list, a bool and an integer all read as confirmations: each
        # stringifies to something non-empty, so each was reported to the owner
        # as a delivered message and stored as the id to reconcile against.
        message_id = valid_provider_message_id((result or {}).get("id"))
        if not message_id:
            # A `{}`, id-less, or malformed response is not a confirmation.
            # Reading it as success reported "sent" on the strength of the call
            # returning — which is the same class of claim as reporting
            # delivery because a request was made. Without the provider's own
            # identifier there is nothing to reconcile against, so this is
            # unverified, not done.
            store.settle_dispatched(
                key, attempt, state="ambiguous",
                result={"error": "provider returned no usable message id",
                        "rfc_message_id": rfc_message_id(fingerprint)},
            )
            _audit("send.ambiguous", target=f"{len(to)} recipient(s)",
                   detail={"fingerprint": fingerprint[:16], "reason": "no_provider_id"})
            return tool_error(
                "Gmail accepted the request but did not return a usable message "
                "id, so the outcome cannot be confirmed. It may have been "
                "delivered. Check the Sent folder before trying again."
            )
        store.settle_dispatched(
            key, attempt, state="succeeded",
            result={"message_id": message_id,
                    "rfc_message_id": rfc_message_id(fingerprint)},
        )
    except Exception as exc:
        # NOT `failed`. We do not know whether it landed, and recording a guess
        # here is what turns one send into two.
        store.settle_dispatched(
            key, attempt, state="ambiguous",
            result={"error": _safe_error(exc, scrub),
                    "rfc_message_id": rfc_message_id(fingerprint)},
        )
        _audit("send.ambiguous", target=f"{len(to)} recipient(s)",
               detail={"fingerprint": fingerprint[:16]})
        return tool_error(
            "the send was handed to Gmail and the outcome is unknown: "
            f"{_safe_error(exc, scrub)}. It may have been delivered. Check the "
            "Sent folder before trying again."
        )

    # Counts and identifiers only — never the body, never a recipient's content.
    _audit(
        "send",
        target=f"{len(to)} recipient(s)",
        # Counts, a fingerprint and a provider id — never a subject, a
        # recipient or a body. An audit row outlives the message, so anything
        # written here is retained content, and a subject line is content.
        detail={"fingerprint": fingerprint[:16], "message_id": message_id},
    )
    payload: dict[str, Any] = {
        "sent": True,
        "message_id": message_id,
        # The broker-controlled id, echoed so a later reconciliation has the
        # exact string to search the Sent folder for.
        "rfc_message_id": rfc_message_id(fingerprint),
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
