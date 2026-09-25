/**
 * CL-8792: allow-once must not stall a second destructive command.
 *
 * The overlay host is a single slot. Before the fix, accepting the first
 * permission card let a deferred replaceable surface (slash help, settings,
 * MCP) take the host while the second permission card stayed queued forever:
 * its overlay never opened and its evaluation never settled. These tests pin
 * the fixed contract:
 *
 * 1. After Accept once, an already-queued or newly raised permission /
 *    operator card takes the host before a deferred slash/settings/MCP
 *    surface.
 * 2. A replaceable command surface already on screen yields to a new
 *    decision gate and returns after that gate settles.
 * 3. A slash requested while a live gate holds the host still waits.
 * 4. A queued card's auto-deny timer does not run until actually shown.
 * 5. A pending tool row does not advance elapsed while a decision gate is
 *    outstanding but not on screen.
 * 6. Allow Once persists nothing; Allow Always / Reject drain in the same
 *    order as Accept once.
 */
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import { createPermissionGate } from "../permission/gate.js";
import type {
  ApprovalOutcome,
  PermissionRequest,
} from "../permission/types.js";
import { defined } from "../../tests/helpers/defined.js";
import { attachSessionBridge, createRecordingPort } from "./runtime-bridge.js";
import { withTestRenderer } from "./harness.js";
import { createAppShell } from "./shell/index.js";
import type { AppShell } from "./shell/internals.js";
import {
  acceptOverlaySelection,
  openListOverlay,
} from "./shell/overlay-host.js";
import { moveOverlaySelection } from "./shell/overlay-list.js";
import { streamRowCount } from "./shell/transcript.js";
import { wireGates } from "./gate-wire.js";
import type { PermissionGateEvent } from "./gate-events.js";
import { createGateRequestApproval } from "./request-approval.js";

const shellCall = (command: string): ToolCall => ({
  id: "c",
  name: "run_shell",
  arguments: { command },
});

const destructiveRequest = (subject: string): PermissionRequest => ({
  tool: "run_shell",
  action: "Run shell command",
  subject,
  scopes: [],
});

/** Accept the highlighted choice after moving to `index` (0 Reject, 1 Accept once). */
function acceptChoice(shell: AppShell, index: 0 | 1 | 2): void {
  for (let i = 0; i < index; i++) moveOverlaySelection(shell, 1);
  acceptOverlaySelection(shell);
}

/** Resolves false when `promise` does not settle within `ms`. */
async function settledWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      promise.then((value) => ({ settled: true as const, value })),
      new Promise<{ settled: false }>((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), ms);
      }),
    ]);
    return value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * `gate.evaluate()` raises its card asynchronously (decide → approval seam →
 * emit → enqueue), so the overlay is never up on the very next line. Flush
 * macrotasks so the card is raised — shown, or queued behind the live gate —
 * before asserting on the host. All gate-side work is microtasks, so two
 * macrotask drains provably suffice; nothing here changes what is asserted.
 */
async function flushGateRaise(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function withWiredWorld(
  run: (world: {
    shell: AppShell;
    emitter: EventEmitter;
    dispose: () => void;
  }) => void | Promise<void>,
): Promise<void> {
  await withTestRenderer(async (h) => {
    const shell = createAppShell(h.renderer, {
      terminal: { columns: 80, rows: 24 },
      run: "idle",
    });
    const emitter = new EventEmitter();
    const dispose = wireGates(emitter, shell);
    try {
      await run({ shell, emitter, dispose });
    } finally {
      dispose();
      shell.dispose();
    }
  });
}

/** A real permission gate whose prompts flow into the TUI overlay host. */
function createOverlayBackedGate(emitter: EventEmitter) {
  const requestApproval = createGateRequestApproval({
    emitGate: (event: PermissionGateEvent) => {
      emitter.emit("permission.gate", event);
      return true;
    },
    approvalTimeout: () => undefined,
  });
  return createPermissionGate({
    approvals: [],
    requestApproval,
    interactive: true,
    skipPermissions: false,
    reactorGated: false,
  });
}

function openSlash(shell: AppShell): void {
  openListOverlay(shell, {
    kind: "help",
    title: "Slash",
    items: ["Help"],
    deferIfBusy: true,
  });
}

describe("CL-8792 gate level: a second destructive evaluation re-prompts after allow-once", () => {
  test("different command re-prompts through the overlay host and settles", async () => {
    await withWiredWorld(async ({ shell, emitter }) => {
      const gate = createOverlayBackedGate(emitter);
      const first = gate.evaluate(shellCall("rm -rf /tmp/cl8792-a"));
      await flushGateRaise();
      expect(shell.overlayKind).toBe("permissions");

      acceptChoice(shell, 1);
      const firstVerdict = await settledWithin(first, 500);
      expect(firstVerdict.settled).toBe(true);
      if (!firstVerdict.settled) throw new Error("first evaluation hung");
      expect(firstVerdict.value.allowed).toBe(true);

      const second = gate.evaluate(shellCall("rm -rf /tmp/cl8792-b"));
      await flushGateRaise();
      // Allow-once persisted nothing, so the new command must prompt again.
      expect(shell.overlayKind).toBe("permissions");
      acceptChoice(shell, 1);
      const secondVerdict = await settledWithin(second, 500);
      expect(secondVerdict.settled).toBe(true);
      if (!secondVerdict.settled) throw new Error("second evaluation hung");
      expect(secondVerdict.value.allowed).toBe(true);
    });
  });

  test("same command re-prompts: allow-once mints no grant", async () => {
    await withWiredWorld(async ({ shell, emitter }) => {
      const gate = createOverlayBackedGate(emitter);
      const command = "rm -rf /tmp/cl8792-same";
      const first = gate.evaluate(shellCall(command));
      await flushGateRaise();
      expect(shell.overlayKind).toBe("permissions");
      acceptChoice(shell, 1);
      await settledWithin(first, 500);

      const second = gate.evaluate(shellCall(command));
      await flushGateRaise();
      // A grant would auto-allow with no overlay; allow-once must re-prompt.
      expect(shell.overlayKind).toBe("permissions");
      acceptChoice(shell, 1);
      const verdict = await settledWithin(second, 500);
      expect(verdict.settled).toBe(true);
      if (!verdict.settled) throw new Error("second evaluation hung");
      expect(verdict.value.allowed).toBe(true);
    });
  });

  test("second evaluation settles under timeout while a deferred slash waits", async () => {
    await withWiredWorld(async ({ shell, emitter }) => {
      const gate = createOverlayBackedGate(emitter);
      const first = gate.evaluate(shellCall("rm -rf /tmp/cl8792-a"));
      await flushGateRaise();
      expect(shell.overlayKind).toBe("permissions");

      // A slash opened under the live gate defers; the live gate keeps it waiting.
      openSlash(shell);
      expect(shell.overlayKind).toBe("permissions");

      const second = gate.evaluate(shellCall("rm -rf /tmp/cl8792-b"));
      // Let the second card enqueue behind the live gate before accepting it.
      await flushGateRaise();

      // Accept once on the first card: the queued card must take the host
      // before the deferred slash, and both evaluations must settle.
      acceptChoice(shell, 1);
      const firstVerdict = await settledWithin(first, 500);
      expect(firstVerdict.settled).toBe(true);

      expect(shell.overlayKind).toBe("permissions");
      acceptChoice(shell, 1);
      const secondVerdict = await settledWithin(second, 500);
      expect(secondVerdict.settled).toBe(true);
      if (!secondVerdict.settled) throw new Error("second evaluation hung");
      expect(secondVerdict.value.allowed).toBe(true);
    });
  });
});

describe("CL-8792 overlay host: queued cards outrank deferred surfaces", () => {
  test("queued permission card takes the host before a deferred slash after accept once", async () => {
    await withWiredWorld(async ({ shell, emitter }) => {
      let resolvedA: unknown;
      let resolvedB: unknown;
      emitter.emit("permission.gate", {
        id: "req-a",
        request: destructiveRequest("rm -rf /tmp/cl8792-a"),
        resolve: (outcome: unknown) => {
          resolvedA = outcome;
        },
      });
      expect(shell.overlayKind).toBe("permissions");

      openSlash(shell);

      emitter.emit("permission.gate", {
        id: "req-b",
        request: destructiveRequest("rm -rf /tmp/cl8792-b"),
        resolve: (outcome: unknown) => {
          resolvedB = outcome;
        },
      });

      acceptChoice(shell, 1);
      expect(resolvedA).toEqual({ allow: true });
      expect(shell.overlayKind).toBe("permissions");
      expect(shell.overlayItems).toContain("Accept once");

      acceptChoice(shell, 1);
      expect(resolvedB).toEqual({ allow: true });

      // With every gate settled, the deferred slash finally takes the host.
      await Promise.resolve();
      expect(shell.overlayKind).toBe("help");
      expect(shell.overlayItems).toEqual(["Help"]);
    });
  });

  test("reject drains like accept once: the next card still outranks the deferred slash", async () => {
    await withWiredWorld(async ({ shell, emitter }) => {
      let resolvedA: unknown;
      let resolvedB: unknown;
      emitter.emit("permission.gate", {
        id: "req-a",
        request: destructiveRequest("git push --force"),
        resolve: (outcome: unknown) => {
          resolvedA = outcome;
        },
      });
      openSlash(shell);
      emitter.emit("permission.gate", {
        id: "req-b",
        request: destructiveRequest("rm -rf /tmp/cl8792-b"),
        resolve: (outcome: unknown) => {
          resolvedB = outcome;
        },
      });

      acceptChoice(shell, 0);
      expect(resolvedA).toEqual({ allow: false });
      expect(shell.overlayKind).toBe("permissions");

      acceptChoice(shell, 1);
      expect(resolvedB).toEqual({ allow: true });
    });
  });

  test("allow always drains like accept once and still mints its grant", async () => {
    await withWiredWorld(async ({ shell, emitter }) => {
      let resolvedA: unknown;
      let resolvedB: unknown;
      emitter.emit("permission.gate", {
        id: "req-a",
        request: {
          ...destructiveRequest("rm -rf /tmp/cl8792-a"),
          scopes: [
            {
              id: "scope-a",
              label: "Allow rm *",
              pattern: "rm *",
              hint: "family",
              grant: "session",
            },
          ],
        },
        resolve: (outcome: unknown) => {
          resolvedA = outcome;
        },
      });
      openSlash(shell);
      emitter.emit("permission.gate", {
        id: "req-b",
        request: destructiveRequest("rm -rf /tmp/cl8792-b"),
        resolve: (outcome: unknown) => {
          resolvedB = outcome;
        },
      });

      acceptChoice(shell, 2);
      expect(resolvedA).toMatchObject({
        allow: true,
        persist: { id: "scope-a" },
      });
      expect(shell.overlayKind).toBe("permissions");

      acceptChoice(shell, 1);
      expect(resolvedB).toEqual({ allow: true });
    });
  });

  test("replaceable command surface on screen yields to a new gate and returns after settle", async () => {
    await withWiredWorld(async ({ shell, emitter }) => {
      let resolved: unknown;
      openSlash(shell);
      expect(shell.overlayKind).toBe("help");

      emitter.emit("permission.gate", {
        id: "req-g",
        request: destructiveRequest("rm -rf /tmp/cl8792-g"),
        resolve: (outcome: unknown) => {
          resolved = outcome;
        },
      });
      expect(shell.overlayKind).toBe("permissions");

      acceptChoice(shell, 1);
      expect(resolved).toEqual({ allow: true });
      expect(shell.overlayKind).toBe("help");
      expect(shell.overlayItems).toEqual(["Help"]);
    });
  });

  test("queued card arms its auto-deny timer only once actually shown", async () => {
    await withWiredWorld(async ({ shell, emitter }) => {
      let resolvedA: unknown;
      let resolvedB: unknown;
      emitter.emit("permission.gate", {
        id: "req-a",
        request: destructiveRequest("rm -rf /tmp/cl8792-a"),
        resolve: (outcome: unknown) => {
          resolvedA = outcome;
        },
        timeoutMs: 60_000,
        timeoutMessage: "denied",
      });
      // A deferred slash competes for the host: the queued card must still
      // take it first after Accept once (single-slot overlay host).
      openSlash(shell);
      emitter.emit("permission.gate", {
        id: "req-b",
        request: destructiveRequest("rm -rf /tmp/cl8792-b"),
        resolve: (outcome: ApprovalOutcome) => {
          resolvedB = outcome;
        },
        timeoutMs: 25,
        timeoutMessage: "queued card timed out",
      });

      // The queued card waits far past its own timeout without firing.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(resolvedB).toBeUndefined();

      acceptChoice(shell, 1);
      expect(resolvedA).toEqual({ allow: true });
      expect(shell.overlayKind).toBe("permissions");

      // Now shown, the same timeout arms and auto-denies.
      const denied = await settledWithin(
        (async () => {
          while (resolvedB === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          return resolvedB;
        })(),
        500,
      );
      expect(denied.settled).toBe(true);
      expect(resolvedB).toMatchObject({ allow: false });
    });
  });
});

describe("CL-8792 elapsed: pending tool row freezes while a gate is outstanding but hidden", () => {
  test("tool row clock holds while the gate is hidden and runs once it shows", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
          run: "busy",
        });
        const emitter = new EventEmitter();
        const disposeGates = wireGates(emitter, shell);
        let nowMs = 0;
        let tick: (() => void) | undefined;
        const bridge = attachSessionBridge(shell, createRecordingPort(), {
          now: () => nowMs,
          schedule: (fn) => {
            tick = fn;
            return () => {
              tick = undefined;
            };
          },
        });
        try {
          bridge.handle({ type: "inference.start", data: {} });
          bridge.handle({
            type: "inference.tool_call.end",
            data: {
              name: "run_shell",
              callId: "c1",
              arguments: "rm -rf /tmp/cl8792-a",
            },
          });
          const index = streamRowCount(shell) - 1;
          const stat = () => defined(shell.streamLog[index], "tool row").stat;

          // A decision gate goes outstanding for the pending call while
          // another surface holds the single overlay slot: hidden gate.
          bridge.gateOpened();
          nowMs = 5_000;
          tick?.();
          await h.renderOnce();
          expect(stat()).toBeUndefined();

          // The same outstanding gate, now actually on screen: the clock runs.
          let resolved: unknown;
          emitter.emit("permission.gate", {
            id: "req-g",
            request: destructiveRequest("rm -rf /tmp/cl8792-a"),
            resolve: (outcome: unknown) => {
              resolved = outcome;
            },
          });
          expect(shell.overlayKind).toBe("permissions");
          nowMs = 10_000;
          tick?.();
          await h.renderOnce();
          expect(stat()).toBe("0:10");

          acceptChoice(shell, 1);
          expect(resolved).toEqual({ allow: true });
          bridge.gateClosed();
        } finally {
          bridge.dispose();
          disposeGates();
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});
