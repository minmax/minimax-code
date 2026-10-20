/**
 * Full-output spill hook for truncated tool results.
 *
 * When a tool result is truncated, the complete output payload can be handed
 * to a spill sink so the model keeps a way back to the full output. The
 * CAS-backed implementation arrives separately; every call site treats the
 * hook as optional and must keep working when it is absent.
 */
export interface ToolOutputSpill {
  /**
   * Persist the complete tool output payload and return a model-readable
   * reference to it (for example a path or a content address), or undefined
   * when the payload was not persisted.
   *
   * Implementations should return undefined instead of throwing for ordinary
   * failures: call sites degrade to a truncated result without a full-output
   * reference rather than failing the tool call.
   */
  spill(payload: string): Promise<string | undefined>;
}
