// Approval snapshot args at rest. Session state (git-backed, under
// .agent-state: the turn log record next to a parked call, or metadata.json)
// persists each PendingOperation verbatim,
// `approvalSnapshot.arguments` included — the raw model arguments of an ask
// the operator has not answered yet. The result-side secret scrubber never
// sees these, so a parked call carrying a bearer-shaped argument persisted it
// into the session store in the clear. Scrub the snapshot copy at the app's
// metadata write boundary; `suspendedCall` stays untouched because the
// re-dispatch of an approved call must see the raw arguments.
//
// Snapshot equality checks (`resolveSuspendedApprovalFromStore`) must not
// collapse every secret to one redaction token before comparing: that made
// two different credentials compare equal. Persisted snapshots are redacted
// at the metadata write, so a fully redacted copy still matches the live raw
// snapshot through the canonical scrub. A copy that still carries raw secret
// material — and the in-memory re-dispatch snapshot — compare without that
// lossy collapse.

import { isDeepStrictEqual } from "node:util";

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

function jsonPlain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

// True when `value` is already the redacted canonical form (the scrub is a
// no-op). A snapshot that still holds a raw credential fails this check.
function isRedactedCanonical(value: unknown): boolean {
  try {
    return isDeepStrictEqual(jsonPlain(value), canonicalSnapshotScrub(value));
  } catch {
    return false;
  }
}

function rawArgumentsEqual(left: unknown, right: unknown): boolean {
  try {
    return isDeepStrictEqual(jsonPlain(left), jsonPlain(right));
  } catch {
    // Non-JSON-safe args cannot be compared raw. Fall back to the shared
    // scrub stub so a parked call still lines up with its own snapshot;
    // JSON-safe credentials never take this path.
    return isDeepStrictEqual(
      canonicalSnapshotScrub(left),
      canonicalSnapshotScrub(right),
    );
  }
}

/**
 * Integrity compare for approval arguments.
 *
 * `persisted` is the on-disk snapshot. When that copy was redacted at rest,
 * secret fields are the stable redaction token and the canonical scrub still
 * lines up with the live raw args. When it still contains a raw credential,
 * compare the values themselves so a different secret is a mismatch.
 *
 * The in-memory re-dispatch snapshot (`persisted: false`) is never collapsed:
 * two different credential values must not compare equal.
 */
export function snapshotArgumentsMatch(
  parked: unknown,
  other: unknown,
  persisted: boolean,
): boolean {
  if (persisted && isRedactedCanonical(other)) {
    return isDeepStrictEqual(
      canonicalSnapshotScrub(parked),
      canonicalSnapshotScrub(other),
    );
  }
  return rawArgumentsEqual(parked, other);
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
