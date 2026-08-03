export function busyStateAfterEvent(current: boolean, eventType: string | undefined): boolean {
  if (eventType === "message.start") return true;
  if (eventType === "message.complete" || eventType === "error") return false;
  return current;
}
