/**
 * One cutover for every model-scoped runtime fact a live session reads.
 * `/model` (and tests) must go through this rather than refreshing inference
 * alone — a missed step is how provider-model grants and kimi wire schemas
 * went stale after a switch.
 */

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
  /**
   * Re-advertise family-gated tool schemas from canonical definitions.
   * Must not re-normalize an already-rewritten advertise set — switching
   * away from kimi would then keep the non-recursive present schema.
   */
  refreshAdvertisedSchemas: (next: LiveModelRef) => void;
}

export function applyLiveModelSwitch(next: LiveModelRef, handles: LiveModelSwitchHandles): void {
  handles.applyIdentity(next);
  handles.setPermissionIdentity(next.providerName, next.model);
  handles.rebuildInference(next);
  handles.refreshAdvertisedSchemas(next);
}
