/**
 * Phase-4 primary-session integration regression for the input-required strip.
 *
 * The marker stamping lives inside assembleTUISession's primary onOperatorGate
 * closure (runner/session.ts), which no existing test seam can invoke without
 * assembling the whole runner. These tests therefore mirror that closure's
 * emission construction exactly and drive the resulting event through a real
 * shell + wireGates host compose: admission, modal behavior, and final strip
 * removal must hold together without changing event routing.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { OperatorResult } from "../../agent/tools.js";
import { defined } from "../../../testkit/defined.js";
import {
  PRIMARY_ASK_OPERATOR_SOURCE,
  type OperatorGateEvent,
} from "../gate-events.js";
import { wireGates } from "../gate-wire.js";
import { NO_OPERATOR_INPUT_REQUIRED } from "../operator-input-required.js";
import { attachApprovalBudget } from "../request-approval.js";
import {
  clearOperatorInputRequired,
  setOperatorInputRequiredGate,
} from "../shell/chrome.js";
import { acceptOverlaySelection } from "../shell/overlay-host.js";
import { withAppShell } from "../test-helpers.js";

/** Mirror session.ts's primary onOperatorGate closure (marker + budget id). */
function emitPrimaryAsk(
  emitter: EventEmitter,
  question: string,
  options: string[],
): { id: string; result: Promise<OperatorResult> } {
  let id = "";
  const result = new Promise<OperatorResult>((resolve) => {
    const { finish, signal } = attachApprovalBudget<OperatorResult>(resolve, {
      tool: "ask_operator",
      kind: "operator",
    });
    const event: OperatorGateEvent = {
      id: randomUUID(),
      source: PRIMARY_ASK_OPERATOR_SOURCE,
      question,
      options,
      resolve: finish,
      ...(signal !== undefined ? { signal } : {}),
    };
    id = event.id;
    emitter.emit("operator.gate", event);
  });
  return { id, result };
}

/** Mirror session.ts's requestMcpTrust emission: a normal, unmarked modal. */
function emitMcpTrust(emitter: EventEmitter): Promise<OperatorResult> {
  return new Promise<OperatorResult>((resolve) => {
    const { finish, signal } = attachApprovalBudget<OperatorResult>(resolve, {
      tool: "mcp:local-server",
      kind: "operator",
    });
    const event: OperatorGateEvent = {
      id: randomUUID(),
      question: "Trust this local MCP server?",
      options: ["Trust and connect", "Cancel"],
      resolve: finish,
      ...(signal !== undefined ? { signal } : {}),
    };
    emitter.emit("operator.gate", event);
  });
}

function primaryHostHooks(shell: Parameters<typeof wireGates>[1]) {
  return {
    onGateOpened: () => undefined,
    onGateClosed: () => undefined,
    onPrimaryOperatorAdmitted: (event: OperatorGateEvent) =>
      setOperatorInputRequiredGate(shell, event),
    onPrimaryOperatorSettled: (event: OperatorGateEvent) =>
      clearOperatorInputRequired(shell, event.id),
  };
}

describe("primary ask_operator emission", () => {
  test("stamps the marker, a unique id, and preserves question, options and resolver", async () => {
    const emitter = new EventEmitter();
    const captured: OperatorGateEvent[] = [];
    emitter.on("operator.gate", (event: OperatorGateEvent) =>
      captured.push(event),
    );
    const first = emitPrimaryAsk(emitter, "Which branch?", ["main", "dev"]);
    const second = emitPrimaryAsk(emitter, "Include tests?", ["yes", "no"]);

    expect(captured).toHaveLength(2);
    for (const event of captured) {
      expect(event.source).toBe(PRIMARY_ASK_OPERATOR_SOURCE);
      expect(typeof event.id).toBe("string");
      expect(event.id.length).toBeGreaterThan(0);
      expect(typeof event.resolve).toBe("function");
    }
    expect(captured[0]?.question).toBe("Which branch?");
    expect(captured[0]?.options).toEqual(["main", "dev"]);
    expect(captured[1]?.question).toBe("Include tests?");
    const firstEvent = defined(captured[0], "captured[0]");
    const secondEvent = defined(captured[1], "captured[1]");
    expect(secondEvent.id).not.toBe(firstEvent.id);
    expect(first.id).toBe(firstEvent.id);
    expect(second.id).toBe(secondEvent.id);
    expect(first.result).toBeInstanceOf(Promise);
  });

  test("drives admission, modal behavior, and final strip removal through the host compose", async () => {
    await withAppShell(
      async (shell) => {
        const emitter = new EventEmitter();
        const disposeGates = wireGates(emitter, shell, primaryHostHooks(shell));
        try {
          const { id, result } = emitPrimaryAsk(emitter, "Which branch?", [
            "main",
            "dev",
          ]);
          expect(
            shell.operatorInputRequired.items.map((item) => item.id),
          ).toEqual([id]);
          expect(shell.layout.heights.input_required).toBe(1);
          expect(shell.overlayKind).toBe("operator");

          acceptOverlaySelection(shell);
          expect(await result).toEqual({ kind: "option", index: 0 });
          expect(shell.operatorInputRequired).toBe(NO_OPERATOR_INPUT_REQUIRED);
          expect(shell.layout.heights.input_required).toBe(0);
          expect(shell.overlayList).toBeNull();
        } finally {
          disposeGates();
        }
      },
      { shell: { run: "idle" } },
    );
  });

  test("an MCP trust emission stays unmarked and never admits an input-required item", async () => {
    await withAppShell(
      async (shell) => {
        const emitter = new EventEmitter();
        const disposeGates = wireGates(emitter, shell, primaryHostHooks(shell));
        try {
          const result = emitMcpTrust(emitter);
          expect(shell.overlayKind).toBe("operator");
          expect(shell.operatorInputRequired).toBe(NO_OPERATOR_INPUT_REQUIRED);
          expect(shell.layout.heights.input_required).toBe(0);

          acceptOverlaySelection(shell);
          expect(await result).toEqual({ kind: "option", index: 0 });
          expect(shell.operatorInputRequired).toBe(NO_OPERATOR_INPUT_REQUIRED);
        } finally {
          disposeGates();
        }
      },
      { shell: { run: "idle" } },
    );
  });
});
