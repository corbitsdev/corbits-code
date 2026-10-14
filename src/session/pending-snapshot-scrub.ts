// Approval snapshot args at rest. metadata.json (git-backed session state
// under .agent-state) persists each PendingOperation verbatim,
// `approvalSnapshot.arguments` included — the raw model arguments of an ask
// the operator has not answered yet. The result-side secret scrubber never
// sees these, so a parked call carrying a bearer-shaped argument persisted it
// into the session store in the clear. Scrub the snapshot copy at the app's
// metadata write boundary; `suspendedCall` stays untouched because the
// re-dispatch of an approved call must see the raw arguments.
//
// Snapshot equality checks (`resolveSuspendedApprovalFromStore`) run through
// the same canonical transform on BOTH sides, so a scrubbed persisted snapshot
// still matches the live raw snapshot exactly the way the unscrubbed copies
// used to — one transform, symmetrically applied.

import type { PendingOperation } from "@intx/types/runtime";

import {
  scrubSecretShapedContent,
  scrubSecretShapedValue,
} from "../plugins/tool-result-secret-scrub.js";

// A single canonical form for a snapshot value: secret-shape scrubbed into
// JSON-plain objects (the store round-trips through JSON, so prototype shape
// must not leak into an equality check). Values the scrubber refuses to prove
// JSON-safe fall back to a scrubbed text stub — fail-closed on both the
// at-rest copy and the comparison form.
export function canonicalSnapshotScrub(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(scrubSecretShapedValue(value)));
  } catch {
    try {
      return {
        scrubbed: scrubSecretShapedContent(JSON.stringify(value)),
      };
    } catch {
      return { scrubbed: "[unscrubbable approval arguments]" };
    }
  }
}

export function scrubPersistedPendingOperations(
  pendingOperations: readonly PendingOperation[],
): PendingOperation[] {
  return pendingOperations.map((op) => {
    const snapshot = op.approvalSnapshot;
    if (snapshot === undefined) return op;
    // Brand-new plain object; nothing else holds this copy, so the live
    // call's args (suspendedCall and the pending op still in the reactor's
    // state manager) stay raw.
    return {
      ...op,
      approvalSnapshot: {
        ...snapshot,
        arguments: canonicalSnapshotScrub(snapshot.arguments) as Record<
          string,
          unknown
        >,
      },
    };
  });
}
