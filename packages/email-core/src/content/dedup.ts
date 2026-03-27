// Thread dedup — STUB for v1
// Preserves full quoted content. No stripping of "On [date], [user] wrote:" chains.
// Rely on limit parameters with sensible defaults so the agent reads incrementally.

/**
 * No-op dedup for v1 — preserves full quoted content.
 * In future versions, this could strip redundant quoted reply chains.
 */
export function dedupThreadContent(body: string): string {
  // v1: no-op — preserve everything
  return body;
}
