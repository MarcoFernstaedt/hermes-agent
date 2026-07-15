export function nextSlashSelection(
  current: number,
  direction: -1 | 1,
  count: number,
): number {
  if (count <= 0) return 0;
  return (current + direction + count) % count;
}
