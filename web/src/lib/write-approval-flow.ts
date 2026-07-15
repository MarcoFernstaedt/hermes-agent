import type {
  WriteApprovalDecision,
  WriteApprovalResponse,
  WriteApprovalSubsystem,
} from "./api";
import { writeApprovalKey, type ChatFeedEvent, type ChatFeedMessage } from "./chat-feed-model";

type ResolveWriteApproval = (
  subsystem: WriteApprovalSubsystem,
  pendingId: string,
  decision: WriteApprovalDecision,
  profile?: string,
) => Promise<WriteApprovalResponse>;

interface SubmitWriteApprovalOptions {
  choice: WriteApprovalDecision;
  dispatch: (event: ChatFeedEvent) => void;
  inFlight: Set<string>;
  message: ChatFeedMessage;
  profile?: string;
  resolve: ResolveWriteApproval;
}

const SAFE_PENDING_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function submitWriteApproval({
  choice,
  dispatch,
  inFlight,
  message,
  profile,
  resolve,
}: SubmitWriteApprovalOptions): Promise<boolean> {
  const pendingId = message.pendingId;
  const subsystem = message.subsystem;
  const cardProfile = (
    message.profile && message.profile !== "current"
      ? message.profile
      : profile ?? "current"
  );
  const key = subsystem && pendingId
    ? writeApprovalKey(cardProfile, subsystem, pendingId)
    : "";
  if (
    message.role !== "write_approval" ||
    message.status !== "waiting" ||
    !pendingId ||
    !subsystem ||
    !SAFE_PENDING_ID.test(pendingId) ||
    inFlight.has(key)
  ) {
    return false;
  }

  inFlight.add(key);
  const identity = { pending_id: pendingId, subsystem, profile: cardProfile };
  dispatch({
    type: "write_approval.submitting",
    payload: identity,
  });
  try {
    const result = await resolve(
      subsystem,
      pendingId,
      choice,
      cardProfile === "current" ? undefined : cardProfile,
    );
    if (!result.success) {
      if (
        result.error === "decision_conflict" &&
        result.subsystem === subsystem &&
        result.pending_id === pendingId &&
        result.decision === choice
      ) {
        dispatch({
          type: "write_approval.resolved",
          payload: { ...identity, decision: "already resolved" },
        });
        return false;
      }
      dispatch({
        type: "write_approval.failed",
        payload: identity,
      });
      return false;
    }
    if (
      result.pending_id !== pendingId ||
      result.subsystem !== subsystem ||
      result.decision !== choice
    ) {
      dispatch({ type: "write_approval.failed", payload: identity });
      return false;
    }
    dispatch({
      type: "write_approval.resolved",
      payload: {
        ...identity,
        decision: choice === "approve" ? "approved" : "rejected",
      },
    });
    return true;
  } catch {
    dispatch({
      type: "write_approval.failed",
      payload: identity,
    });
    return false;
  } finally {
    inFlight.delete(key);
  }
}
