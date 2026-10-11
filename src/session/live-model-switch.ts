/** One cutover for every model-scoped runtime fact a live session reads.
 * `/model` must use this, not refresh inference alone — a missed step
 * leaves grants and wire schemas stale. */

export interface LiveModelRef {
  providerName: string;
  model: string;
}

export function providerModelKey(ref: LiveModelRef): string {
  return `${ref.providerName}:${ref.model}`;
}

export interface LiveModelSwitchHandles {
  /** Session config / live identity that persist getters read. */
  applyIdentity: (next: LiveModelRef) => void;
  /** Permission-gate matching and mint identity. */
  setPermissionIdentity: (providerName: string, model: string) => void;
  /** Rebuild inference sources for the next turn. */
  rebuildInference: (next: LiveModelRef) => void;
  /** Re-advertise family-gated tool schemas from canonical definitions;
   * never re-normalize an already-rewritten set. */
  refreshAdvertisedSchemas: (next: LiveModelRef) => void;
}

export function applyLiveModelSwitch(
  next: LiveModelRef,
  handles: LiveModelSwitchHandles,
): void {
  handles.applyIdentity(next);
  handles.setPermissionIdentity(next.providerName, next.model);
  handles.rebuildInference(next);
  handles.refreshAdvertisedSchemas(next);
}
