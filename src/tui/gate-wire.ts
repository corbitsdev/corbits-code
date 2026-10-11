/**
 * Pure gate wiring: permission/operator events → overlay rows, selection →
 * settled outcomes.
 */

import type { EventEmitter } from "node:events";
import type { OperatorResult } from "../agent/tools.js";
import { formatCommandForApproval } from "./command-display.js";
import { openOperatorOverlay, openPermissionsOverlay } from "./overlays.js";
import type {
  ApprovalOutcome,
  ApprovalScope,
  PermissionRequest,
} from "../permission/types.js";
import { appendStreamRow } from "./shell/chrome.js";
import type { AppShell, OverlaySelection } from "./shell/internals.js";
import {
  closeInsetOverlay,
  isOverlayHostIdle,
  onOverlayClosed,
  resumeSuspendedCommandSurface,
  setOverlayBody,
  suspendReplaceableOverlay,
} from "./shell/overlay-host.js";
import { EXPAND_KEY } from "./stream.js";
import {
  APPROVAL_UNAVAILABLE_MESSAGE,
  type OperatorGateEvent,
  type PermissionGateEvent,
} from "./gate-events.js";
import {
  createPermissionRequestQueue,
  wirePermissionGrantReconciliation,
} from "../permission/queue.js";

/** Stable sentinel ids for the always-present deny / once rows. */
export const PERMISSION_DENY_ID = "__deny__" as const;
export const PERMISSION_ONCE_ID = "__once__" as const;

/**
 * Expand/collapse chord for collapsed payloads. Scoped to the modal overlay
 * rather than SHELL_SHORTCUTS: nothing else in the shell claims a bare letter
 * while it is open. Shared with transcript rows.
 */
export const PERMISSION_EXPAND_KEY = EXPAND_KEY;

export interface PermissionGateChoices {
  readonly items: readonly string[];
  readonly itemIds: readonly string[];
  /** Parallel to itemIds — looked up by selection id. */
  readonly outcomes: readonly ApprovalOutcome[];
}

export interface GateSelection {
  readonly index: number;
  /** When present, the only lookup key. Omitted id fail-closes. */
  readonly id?: string;
}

/**
 * Rows from a live PermissionRequest. Labels stay bare action names; scope
 * hints paint in the body (permissionBodyFromRequest), not inside a choice
 * row.
 */
export function permissionChoicesFromRequest(
  request: PermissionRequest,
  askId: string,
): PermissionGateChoices {
  const items: string[] = [];
  const itemIds: string[] = [];
  const outcomes: ApprovalOutcome[] = [];
  const rowId = (part: string): string => `${askId}:${part}`;

  items.push("Reject");
  itemIds.push(rowId(PERMISSION_DENY_ID));
  outcomes.push({ allow: false });

  items.push("Accept once");
  itemIds.push(rowId(PERMISSION_ONCE_ID));
  outcomes.push({ allow: true });

  for (const scope of request.scopes) {
    items.push(scope.label);
    itemIds.push(rowId(scope.id));
    outcomes.push({
      allow: true,
      ...(scope.pattern !== null ? { persist: scope as ApprovalScope } : {}),
    });
  }

  return { items, itemIds, outcomes };
}

/**
 * Unknown or omitted id fail-closes as unavailable. No index fallback.
 */
export function approvalOutcomeFromSelection(
  choices: PermissionGateChoices,
  selection: GateSelection,
): ApprovalOutcome {
  if (selection.id === undefined) {
    return { allow: false, message: APPROVAL_UNAVAILABLE_MESSAGE };
  }
  const byId = choices.itemIds.indexOf(selection.id);
  if (byId >= 0) {
    return (
      choices.outcomes[byId] ?? {
        allow: false,
        message: APPROVAL_UNAVAILABLE_MESSAGE,
      }
    );
  }
  return { allow: false, message: APPROVAL_UNAVAILABLE_MESSAGE };
}

export interface PermissionBodyOpts {
  /** Print collapsed payloads in full under their placeholder. */
  readonly expanded?: boolean;
  /** Append the expand/collapse affordance line (overlay only). */
  readonly hint?: boolean;
}

/**
 * Compact multi-line body for stream/overlay (no paint): one numbered line
 * per chained segment, a collapsed placeholder the operator can expand
 * before approving, scope hints above the bare choice list, and the expand
 * key dumps the whole body when the overlay clips it.
 */
export function permissionBodyFromRequest(
  request: PermissionRequest,
  opts?: PermissionBodyOpts,
): string {
  const display = formatCommandForApproval(request.subject, {
    expanded: opts?.expanded === true,
  });
  const hint =
    opts?.hint === true && display.payloadCount > 0
      ? opts.expanded === true
        ? `${PERMISSION_EXPAND_KEY} collapse payloads`
        : `${PERMISSION_EXPAND_KEY} expand ${display.payloadCount} collapsed payload${display.payloadCount === 1 ? "" : "s"}`
      : "";
  return [
    request.tool,
    request.action,
    ...display.lines,
    ...request.scopes.flatMap((scope) =>
      scope.hint ? [`${scope.label}: ${scope.hint}`] : [],
    ),
    request.agentLabel ? `agent: ${request.agentLabel}` : "",
    request.notice ?? "",
    hint,
  ]
    .filter((l) => l.length > 0)
    .join("\n");
}

export interface OperatorGateChoices {
  readonly items: readonly string[];
  readonly itemIds: readonly string[];
}

/**
 * itemIds are `${askId}:${index}` so sequential asks cannot collide on
 * render-order index.
 */
export function operatorChoicesFromOptions(
  options: readonly string[],
  askId: string,
): OperatorGateChoices {
  return {
    items: [...options],
    itemIds: options.map((_, i) => `${askId}:${i}`),
  };
}

/**
 * Unknown or omitted id → cancel. No index fallback.
 */
export function operatorResultFromSelection(
  choices: OperatorGateChoices,
  selection: GateSelection,
): OperatorResult {
  if (selection.id === undefined) {
    return { kind: "cancel" };
  }
  const byId = choices.itemIds.indexOf(selection.id);
  if (byId >= 0) {
    return { kind: "option", index: byId };
  }
  return { kind: "cancel" };
}

export function operatorCancelResult(): OperatorResult {
  return { kind: "cancel" };
}

export function operatorCustomResult(text: string): OperatorResult {
  return { kind: "custom", text };
}

/**
 * Blocked-ness is domain state, not paint: the watchdog and the painter both
 * need to know a gate is outstanding before it reaches the screen. This
 * module sees the full lifecycle (raised, queued, resolved) and reports it;
 * callers fold the pair into their own turn state.
 */
export interface GateLifecycleHooks {
  /** A gate was raised — queued or opened, whichever comes first. */
  readonly onGateOpened: () => void;
  /** A previously raised gate resolved. */
  readonly onGateClosed: () => void;
}

const NOOP_GATE_HOOKS: GateLifecycleHooks = {
  onGateOpened: () => undefined,
  onGateClosed: () => undefined,
};

/**
 * Wrap `resolve` so `onGateClosed` fires exactly once, whichever settle
 * path runs first.
 */
function onceClosed<T>(
  onGateClosed: () => void,
  resolve: (value: T) => void,
): (value: T) => void {
  let closed = false;
  return (value) => {
    if (!closed) {
      closed = true;
      onGateClosed();
    }
    resolve(value);
  };
}

/**
 * Subscribe the permission/operator gate events to the shell's overlays.
 * Returns a dispose that removes exactly the listeners this call added.
 */
export function wireGates(
  emitter: EventEmitter,
  shell: AppShell,
  hooks: GateLifecycleHooks = NOOP_GATE_HOOKS,
): () => void {
  // One overlay host: a gate arriving while another is up waits here until
  // the host frees.
  const pending: (() => void)[] = [];
  let disposed = false;
  // Owns queued-approval reconciliation (src/permission/queue.ts); this host
  // only enqueues and renders — it never decides which grant covers a request.
  const permissionQueue = createPermissionRequestQueue();
  const disposeReconciliation = wirePermissionGrantReconciliation(
    emitter,
    permissionQueue,
  );
  // Operator gates have no queue module; each registers a teardown here so a
  // gate still queued at session teardown settles instead of hanging its
  // promise.
  const operatorTeardowns = new Set<() => void>();
  // Bumped on every open. A settle that knows only "my overlay opened" cannot
  // tell whether the host has since opened a newer gate; comparing the
  // open-time capture against the current value closes only its own overlay.
  let overlayGeneration = 0;

  function openHost(open: () => void): void {
    overlayGeneration++;
    open();
  }

  function openOrQueue(open: () => void): void {
    if (isOverlayHostIdle(shell)) {
      openHost(open);
      return;
    }
    if (shell.overlayList !== null) {
      // A replaceable command surface yields to the gate and is restored
      // after it settles; live gates and stacked popups keep their stacking
      // contracts, so those arrivals stay queued.
      pending.push(open);
      suspendReplaceableOverlay(shell);
      // The suspend-close's idle-notify may already have opened an older
      // queued gate (FIFO): drain here only if the host is still free, so a
      // close-notify drain is never doubled.
      if (shell.overlayList === null) {
        const next = pending.shift();
        if (next !== undefined) openHost(next);
      }
      return;
    }
    pending.push(open);
  }

  /**
   * Open the next queued gate, else restore a suspended command surface.
   * Skipped past teardown so a late settle cannot paint a dead shell.
   */
  function drainPendingOrResume(): void {
    if (disposed || shell.disposed) return;
    // A close-notify drain may already have taken the host (Esc / timeout
    // while displayed): never double-open, and never tear down a live gate.
    if (shell.overlayList !== null) return;
    const next = pending.shift();
    if (next !== undefined) {
      openHost(next);
      return;
    }
    resumeSuspendedCommandSurface(shell);
  }

  function unqueue(open: () => void): void {
    const idx = pending.indexOf(open);
    if (idx >= 0) pending.splice(idx, 1);
  }

  const disposeClosed = onOverlayClosed(shell, () => {
    const next = pending.shift();
    if (next) openHost(next);
  });

  function onPermission(ev: PermissionGateEvent): void {
    hooks.onGateOpened();
    const resolve = onceClosed(hooks.onGateClosed, ev.resolve);
    if (typeof ev.id !== "string" || ev.id.length === 0) {
      resolve({ allow: false, message: APPROVAL_UNAVAILABLE_MESSAGE });
      return;
    }
    const choices = permissionChoicesFromRequest(ev.request, ev.id);
    const collapsedBody = permissionBodyFromRequest(ev.request, { hint: true });
    // Nothing was collapsed → no expand affordance, so the overlay leaves the
    // bare key unclaimed.
    const collapsedAnything =
      formatCommandForApproval(ev.request.subject).payloadCount > 0;
    let expanded = false;
    // Set when this gate's own overlay is on screen; settle compares it
    // against the current generation (see overlayGeneration above).
    let openedGeneration: number | undefined;

    // The queue is the single settle guard: once an id leaves it, later
    // calls no-op. Its callback resolves through the onceClosed wrapper.
    const settle = (outcome: ApprovalOutcome): boolean =>
      permissionQueue.settle(id, outcome);
    const id = permissionQueue.enqueue(ev.request, (outcome) => {
      clearTimers();
      if (openedGeneration === undefined) {
        unqueue(open);
      } else if (openedGeneration === overlayGeneration) {
        closeInsetOverlay(shell);
      }
      resolve(outcome);
      // Queued gates take the host before any suspended surface returns.
      drainPendingOrResume();
    });

    const onToggleExpand = (): void => {
      expanded = !expanded;
      setOverlayBody(
        shell,
        permissionBodyFromRequest(ev.request, { expanded, hint: true }),
      );
      if (!expanded) return;
      // The overlay body is height-capped; the expanded payload's
      // authoritative copy goes to the scrollable transcript, whole and
      // untruncated, so collapsing never hides text the operator cannot
      // otherwise reach before approving.
      appendStreamRow(shell, {
        role: "system",
        text: permissionBodyFromRequest(ev.request, { expanded: true }),
      });
    };

    const open = (): void => {
      openedGeneration = overlayGeneration;
      // The gate may have waited in `pending` — this is when it reaches the
      // screen, distinct from when it was raised (see
      // PermissionRequest.markDisplayed).
      ev.request.markDisplayed?.();
      if (ev.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          autoDeny(ev.timeoutMessage ?? "approval timed out; request denied");
        }, ev.timeoutMs);
      }
      openPermissionsOverlay(shell, {
        items: choices.items,
        itemIds: choices.itemIds,
        body: collapsedBody,
        // A settled gate must not replay the ask into the transcript.
        echoChoice: false,
        ...(collapsedAnything ? { onToggleExpand } : {}),
        onAccept: (sel: OverlaySelection) => {
          const gateSelection = {
            index: sel.index,
            ...(sel.id !== undefined ? { id: sel.id } : {}),
          };
          settle(approvalOutcomeFromSelection(choices, gateSelection));
        },
        // Esc settles as a deny, never abandons the awaited promise.
        onCancel: () => {
          const denyId = choices.itemIds[0];
          settle(
            approvalOutcomeFromSelection(choices, {
              index: 0,
              ...(denyId !== undefined ? { id: denyId } : {}),
            }),
          );
        },
        isGate: true,
      });
    };

    // Abort and timeout race an operator who may never answer; whichever
    // fires first settles, the other no-ops. The timeout is
    // display-dependent and arms inside `open` so a queued request does not
    // burn it unseen; the abort listener registers immediately.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      ev.signal?.removeEventListener("abort", onAbort);
    };
    const autoDeny = (message: string): void => {
      settle({ allow: false, message });
    };
    function onAbort(): void {
      const reason = ev.signal?.reason;
      autoDeny(
        typeof reason === "string" && reason.length > 0
          ? reason
          : "tool no longer running; permission request denied",
      );
    }
    if (ev.signal?.aborted === true) {
      onAbort();
      return;
    }
    ev.signal?.addEventListener("abort", onAbort, { once: true });

    openOrQueue(open);
  }

  function onOperator(ev: OperatorGateEvent): void {
    hooks.onGateOpened();
    const resolve = onceClosed(hooks.onGateClosed, ev.resolve);
    if (typeof ev.id !== "string" || ev.id.length === 0) {
      resolve(operatorCancelResult());
      return;
    }
    const choices = operatorChoicesFromOptions(ev.options, ev.id);
    // Guarded like the permission gate: a settle path that forgets its guard
    // would double-resolve this promise.
    let settled = false;
    // Set only while this gate's own overlay is the one on screen — mirrors
    // openedGeneration on the permission path (see its comment above).
    let openedGeneration: number | undefined;

    // Same race as the permission path above: the timeout arms inside `open`
    // (display-dependent), the abort listener registers immediately.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      ev.signal?.removeEventListener("abort", onAbort);
    };

    const open = (): void => {
      openedGeneration = overlayGeneration;
      if (ev.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          autoCancel();
        }, ev.timeoutMs);
      }
      openOperatorOverlay(shell, {
        body: ev.question,
        choices: choices.items,
        itemIds: choices.itemIds,
        // A settled gate must not replay the ask into the transcript.
        echoChoice: false,
        onAccept: (sel: OverlaySelection) => {
          settleOnce(
            operatorResultFromSelection(choices, {
              index: sel.index,
              ...(sel.id !== undefined ? { id: sel.id } : {}),
            }),
          );
        },
        // ask_operator allows a free-form answer, so the overlay must send one
        // back, not just an option index.
        onTextAnswer: (text: string) => {
          settleOnce(operatorCustomResult(text));
        },
        // Esc cancels; the shell already closed this overlay, so unlike
        // autoCancel this must not re-invoke closeInsetOverlay (which would
        // reenter onCancel).
        onCancel: () => {
          settleOnce(operatorCancelResult());
        },
        isGate: true,
      });
    };

    const settleOnce = (result: OperatorResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      operatorTeardowns.delete(teardown);
      if (openedGeneration === undefined) {
        unqueue(open);
      } else if (openedGeneration === overlayGeneration) {
        closeInsetOverlay(shell);
      }
      resolve(result);
      // Queued gates take the host before any suspended surface returns.
      drainPendingOrResume();
    };
    const autoCancel = (): void => {
      settleOnce(operatorCancelResult());
    };
    const teardown = (): void => {
      autoCancel();
    };
    function onAbort(): void {
      autoCancel();
    }
    if (ev.signal?.aborted === true) {
      autoCancel();
      return;
    }
    ev.signal?.addEventListener("abort", onAbort, { once: true });
    operatorTeardowns.add(teardown);

    openOrQueue(open);
  }

  emitter.on("permission.gate", onPermission);
  emitter.on("operator.gate", onOperator);

  return () => {
    disposed = true;
    emitter.off("permission.gate", onPermission);
    emitter.off("operator.gate", onOperator);
    disposeReconciliation();
    disposeClosed();
    pending.length = 0;
    // Deny anything still queued so its awaited evaluate() call never hangs
    // past session teardown.
    permissionQueue.drain();
    // Cancel every outstanding operator gate (queued or displayed) so its
    // resolve() never hangs past teardown — the operator-side equivalent of
    // drain().
    for (const teardown of [...operatorTeardowns]) teardown();
  };
}
