/**
 * Idle-only one-action reconnect offer for reconnect-class terminal failures
 * (credential_failure on a known-OAuth provider id): re-authenticate the
 * failed `kind/profile` scope, then replay the turn once when nothing was
 * committed. Mirrors credential-recovery's begin/observe/settle/accept shape
 * — the two offers share one submit/exit seat and continuation slot, so they
 * speak the same state language. Enter re-keys via a pre-scoped /connect;
 * Esc returns to the composer.
 */

import type { InboundMessage } from "@intx/types/runtime";
import { isOperatorOriginated } from "../../agent/message-provenance.js";
import { buildCredentialRecoveryContinuationMessage } from "./credential-recovery.js";
import type { ReconnectScope } from "../connect-scope.js";
import { splitReconnectScope } from "../../inference-error-message.js";
import { isKnownOAuthProviderId } from "../../inference-gateway-error.js";

export interface PendingReconnectRecovery {
  readonly generation: number;
  readonly failedProvider: string;
  readonly scope: ReconnectScope;
  readonly message: InboundMessage;
  readonly committed: boolean;
}

export interface ReconnectRecoveryAttempt {
  readonly generation: number;
  failedProvider: string;
  readonly message: InboundMessage;
  committed: boolean;
  sawCredentialRetry: boolean;
  terminalReconnectFailure: boolean;
}

type RecoveryEvent = {
  readonly type: string;
  readonly data?: unknown;
};

type RecoveryEventData = {
  readonly previousError?: { readonly category?: string };
  readonly error?: {
    readonly category?: string;
    readonly providerId?: string;
  };
};

function recoveryEventData(
  event: RecoveryEvent,
): RecoveryEventData | undefined {
  if (typeof event.data !== "object" || event.data === null) return undefined;
  return event.data as RecoveryEventData;
}

export type ReconnectRecoveryAcceptance =
  | { readonly kind: "stale" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "accepted";
      readonly generation: number;
      readonly scope: ReconnectScope;
      readonly replay: boolean;
    };

function isHarnessCommittingEvent(event: RecoveryEvent): boolean {
  if (!event.type.startsWith("inference.")) return false;
  // Keep the exact harness.ts isCommitting set. runInference handles these
  // wrapper terminal events before consulting that predicate.
  switch (event.type) {
    case "inference.start":
    case "inference.usage":
    case "inference.done":
    case "inference.error":
    case "inference.retry":
      return false;
    default:
      return true;
  }
}

/**
 * Item id for the single reconnect row. Namespaced so accept() can reject
 * foreign ids rather than re-keying the wrong profile.
 */
export function reconnectRecoveryItemId(scope: ReconnectScope): string {
  return `reconnect:${scope.kind}/${scope.profile}`;
}

export function reconnectRecoveryItemLabel(scope: ReconnectScope): string {
  return `Reconnect ${scope.kind}/${scope.profile} — re-authenticate "${scope.profile}"`;
}

export type { ReconnectScope } from "../connect-scope.js";
export {
  buildReconnectCommand,
  parseConnectScopeArgs,
} from "../connect-scope.js";

export function createReconnectRecoveryState() {
  let nextGeneration = 0;
  let pending: PendingReconnectRecovery | null = null;

  return {
    begin(
      message: InboundMessage,
      failedProvider: string,
    ): ReconnectRecoveryAttempt {
      if (isOperatorOriginated(message.flags)) pending = null;
      return {
        generation: ++nextGeneration,
        failedProvider,
        message,
        committed: false,
        sawCredentialRetry: false,
        terminalReconnectFailure: false,
      };
    },
    observe(attempt: ReconnectRecoveryAttempt, event: RecoveryEvent): void {
      if (attempt.generation !== nextGeneration) return;
      if (isHarnessCommittingEvent(event)) attempt.committed = true;
      const data = recoveryEventData(event);
      if (
        event.type === "inference.retry" &&
        data?.previousError?.category === "credential_failure"
      ) {
        attempt.sawCredentialRetry = true;
      }
      if (event.type === "inference.error") {
        attempt.terminalReconnectFailure =
          data?.error?.category === "credential_failure";
        const providerId = data?.error?.providerId;
        if (providerId !== undefined && providerId.length > 0) {
          attempt.failedProvider = providerId;
        }
      }
    },
    settle(attempt: ReconnectRecoveryAttempt): PendingReconnectRecovery | null {
      if (
        attempt.generation !== nextGeneration ||
        !isOperatorOriginated(attempt.message.flags) ||
        !attempt.sawCredentialRetry ||
        !attempt.terminalReconnectFailure ||
        !isKnownOAuthProviderId(attempt.failedProvider)
      ) {
        return null;
      }
      const scope = splitReconnectScope(attempt.failedProvider);
      if (scope === undefined) return null;
      pending = {
        generation: attempt.generation,
        failedProvider: attempt.failedProvider,
        scope,
        message: attempt.message,
        committed: attempt.committed,
      };
      return pending;
    },
    cancel(generation: number): boolean {
      if (pending?.generation !== generation) return false;
      pending = null;
      return true;
    },
    accept(
      generation: number,
      selectedId: string,
    ): ReconnectRecoveryAcceptance {
      if (pending?.generation !== generation) return { kind: "stale" };
      const claimed = pending;
      pending = null;
      if (selectedId !== reconnectRecoveryItemId(claimed.scope)) {
        return { kind: "invalid" };
      }
      return {
        kind: "accepted",
        generation,
        scope: claimed.scope,
        replay: !claimed.committed,
      };
    },
    isCurrent(generation: number): boolean {
      return generation === nextGeneration;
    },
    clear(): void {
      pending = null;
      nextGeneration++;
    },
  };
}

export function applyReconnectRecoverySelection(args: {
  state: ReturnType<typeof createReconnectRecoveryState>;
  generation: number;
  selectedId: string;
  reconnect: (
    scope: ReconnectScope,
    onComplete: (connected: boolean) => void,
  ) => void;
  armContinuation: (generation: number) => void;
  cancelContinuation: (generation: number) => void;
  deliverContinuation: (message: InboundMessage) => void;
}): "stale" | "invalid" | "reconnect-failed" | "reconnected" {
  const acceptance = args.state.accept(args.generation, args.selectedId);
  if (acceptance.kind !== "accepted") return acceptance.kind;
  let completed = false;
  const onComplete = (connected: boolean): void => {
    if (completed) return;
    completed = true;
    if (
      !connected ||
      !acceptance.replay ||
      !args.state.isCurrent(acceptance.generation)
    ) {
      return;
    }
    args.armContinuation(acceptance.generation);
    try {
      args.deliverContinuation(
        buildCredentialRecoveryContinuationMessage(acceptance.generation),
      );
    } catch {
      args.cancelContinuation(acceptance.generation);
    }
  };
  try {
    args.reconnect(acceptance.scope, onComplete);
  } catch {
    return "reconnect-failed";
  }
  return "reconnected";
}

/**
 * Idle-offer presentation for a settled reconnect recovery: opens the
 * one-action dialog, routes Enter into a pre-scoped /connect with
 * replay-once when nothing committed, Esc into a clean cancel with no
 * cascade to the credential picker. Mirrors the inline
 * presentCredentialRecovery wiring in runner/index.ts — the two offers
 * share one submit/exit seat, so their dismiss/accept shapes must stay
 * identical. Factored so the wiring is unit-testable.
 */
export function createReconnectRecoveryPresenter(args: {
  recovery: ReturnType<typeof createReconnectRecoveryState>;
  openDialog: (dialog: {
    scope: ReconnectScope;
    onAccept: (id: string) => void;
    onCancel: () => void;
  }) => boolean;
  openReconnect: (
    scope: ReconnectScope,
    onComplete: (connected: boolean) => void,
  ) => boolean;
  readDirector: () =>
    | {
        armCredentialRecoveryContinuation: (generation: number) => void;
        cancelCredentialRecoveryContinuation: (generation: number) => void;
      }
    | undefined;
  deliverContinuation: (message: InboundMessage) => void;
}): (pending: PendingReconnectRecovery) => void {
  return (pending) => {
    const opened = args.openDialog({
      scope: pending.scope,
      onCancel: () => {
        args.recovery.cancel(pending.generation);
      },
      onAccept: (id) => {
        const director = args.readDirector();
        if (director === undefined) {
          args.recovery.cancel(pending.generation);
          return;
        }
        applyReconnectRecoverySelection({
          state: args.recovery,
          generation: pending.generation,
          selectedId: id,
          reconnect: (scope, onComplete) => {
            if (!args.openReconnect(scope, onComplete)) {
              throw new Error(
                `reconnect surface unavailable for ${scope.kind}/${scope.profile}`,
              );
            }
          },
          armContinuation: (generation) =>
            director.armCredentialRecoveryContinuation(generation),
          cancelContinuation: (generation) =>
            director.cancelCredentialRecoveryContinuation(generation),
          deliverContinuation: args.deliverContinuation,
        });
      },
    });
    if (!opened) args.recovery.cancel(pending.generation);
  };
}
