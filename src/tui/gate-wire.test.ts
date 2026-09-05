/**
 * Pure gate-wire unit tests — no renderer.
 */
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "../permission/types.js";
import type { KeyEvent } from "@opentui/core";
import { withTestRenderer, type Harness } from "./harness.js";
import { OVERLAY_MAX_FRACTION } from "./geometry/index.js";
import {
  acceptOverlaySelection,
  closeInsetOverlay,
  createAppShell,
  exitOverlayAnswerMode,
  handleOverlayAnswerKey,
  moveOverlaySelection,
  setOverlayAnswerActive,
  toggleOverlayExpand,
  type AppShell,
} from "./shell.js";
import { streamRowGutter } from "./stream.js";
import {
  approvalOutcomeFromSelection,
  operatorCancelResult,
  operatorChoicesFromOptions,
  operatorCustomResult,
  operatorResultFromSelection,
  PERMISSION_DENY_ID,
  PERMISSION_ONCE_ID,
  permissionBodyFromRequest,
  permissionChoicesFromRequest,
  wireGates,
} from "./gate-wire.js";

const baseRequest = (overrides: Partial<PermissionRequest> = {}): PermissionRequest => ({
  tool: "run_shell",
  action: "Run shell command",
  subject: "bun test",
  scopes: [],
  ...overrides,
});

describe("permissionChoicesFromRequest", () => {
  test("always includes reject + accept once", () => {
    const choices = permissionChoicesFromRequest(baseRequest());
    expect(choices.items).toEqual(["Reject", "Accept once"]);
    expect(choices.itemIds).toEqual([PERMISSION_DENY_ID, PERMISSION_ONCE_ID]);
    expect(choices.outcomes).toEqual([{ allow: false }, { allow: true }]);
  });

  test("appends scopes with optional hint; persist only when pattern set", () => {
    const scopeWithPattern = {
      id: "session-git",
      label: "Allow git *",
      pattern: "git *",
      hint: "family",
      grant: "session" as const,
    };
    const onceScope = {
      id: "once-extra",
      label: "Allow this path",
      pattern: null,
    };
    const choices = permissionChoicesFromRequest(
      baseRequest({
        scopes: [scopeWithPattern, onceScope],
      }),
    );
    expect(choices.items).toEqual([
      "Reject",
      "Accept once",
      "Allow git * (family)",
      "Allow this path",
    ]);
    expect(choices.itemIds).toEqual([
      PERMISSION_DENY_ID,
      PERMISSION_ONCE_ID,
      "session-git",
      "once-extra",
    ]);
    expect(choices.outcomes[2]).toEqual({
      allow: true,
      persist: scopeWithPattern,
    });
    expect(choices.outcomes[3]).toEqual({ allow: true });
  });
});

describe("approvalOutcomeFromSelection", () => {
  test("index maps to parallel outcomes; OOB denies", () => {
    const choices = permissionChoicesFromRequest(
      baseRequest({
        scopes: [
          {
            id: "proj",
            label: "Allow always",
            pattern: "bun test",
            grant: "project",
          },
        ],
      }),
    );
    expect(approvalOutcomeFromSelection(choices, { index: 0 })).toEqual({
      allow: false,
    });
    expect(approvalOutcomeFromSelection(choices, { index: 1 })).toEqual({
      allow: true,
    });
    expect(approvalOutcomeFromSelection(choices, { index: 2 }).allow).toBe(true);
    expect(approvalOutcomeFromSelection(choices, { index: 2 }).persist?.id).toBe("proj");
    expect(approvalOutcomeFromSelection(choices, { index: 99 })).toEqual({
      allow: false,
    });
  });

  test("id preferred over index when present", () => {
    const choices = permissionChoicesFromRequest(
      baseRequest({
        scopes: [
          { id: "a", label: "A", pattern: "a*" },
          { id: "b", label: "B", pattern: "b*" },
        ],
      }),
    );
    const byId = approvalOutcomeFromSelection(choices, {
      index: 0,
      id: "b",
    });
    expect(byId.allow).toBe(true);
    expect(byId.persist?.id).toBe("b");
  });

  test("unknown id falls back to index", () => {
    const choices = permissionChoicesFromRequest(baseRequest());
    expect(
      approvalOutcomeFromSelection(choices, {
        index: 1,
        id: "missing",
      }),
    ).toEqual({ allow: true });
  });
});

describe("permissionBodyFromRequest", () => {
  test("joins tool/action/subject and optional agent/notice", () => {
    expect(permissionBodyFromRequest(baseRequest())).toBe("run_shell\nRun shell command\nbun test");
    expect(
      permissionBodyFromRequest(
        baseRequest({
          agentLabel: "explorer",
          notice: "mega-chain",
        }),
      ),
    ).toBe("run_shell\nRun shell command\nbun test\nagent: explorer\nmega-chain");
  });

  test("a chained command stays visibly chained, one numbered line per segment", () => {
    const body = permissionBodyFromRequest(
      baseRequest({ subject: "npm install && rm -rf /tmp/cache; echo done" }),
    );
    expect(body.split("\n").slice(2)).toEqual([
      "1) npm install",
      "2) rm -rf /tmp/cache",
      "3) echo done",
    ]);
  });

  test("bulk payloads collapse to a placeholder with an expand hint", () => {
    const request = baseRequest({
      subject: 'git commit -m "line one\nline two\nline three"',
    });
    const collapsed = permissionBodyFromRequest(request, { hint: true });
    expect(collapsed).toContain("<message, 3 lines>");
    expect(collapsed).not.toContain("line two");
    expect(collapsed).toContain("e expand 1 collapsed payload");
  });

  test("expanding keeps the placeholder and reveals every payload line", () => {
    const request = baseRequest({
      subject: 'git commit -m "line one\nline two\nline three"',
    });
    const expanded = permissionBodyFromRequest(request, {
      expanded: true,
      hint: true,
    });
    expect(expanded).toContain("<message, 3 lines>");
    expect(expanded).toContain("line one");
    expect(expanded).toContain("line two");
    expect(expanded).toContain("line three");
    expect(expanded).toContain("e collapse payloads");
  });

  test("code-consuming segments are never collapsed", () => {
    const body = permissionBodyFromRequest(
      baseRequest({ subject: "bash -c 'echo one\necho two'" }),
    );
    expect(body).toContain("echo two");
    expect(body).not.toContain("<text,");
  });
});

describe("operatorChoicesFromOptions / operatorResultFromSelection", () => {
  test("choices mirror options with index string ids", () => {
    const opts = ["Cancel", "Option A", "Option B"];
    const choices = operatorChoicesFromOptions(opts);
    expect(choices.items).toEqual(opts);
    expect(choices.itemIds).toEqual(["0", "1", "2"]);
  });

  test("selection index → option; OOB → cancel", () => {
    const opts = ["A", "B"];
    expect(operatorResultFromSelection(opts, { index: 0 })).toEqual({
      kind: "option",
      index: 0,
    });
    expect(operatorResultFromSelection(opts, { index: 1 })).toEqual({
      kind: "option",
      index: 1,
    });
    expect(operatorResultFromSelection(opts, { index: -1 })).toEqual({
      kind: "cancel",
    });
    expect(operatorResultFromSelection(opts, { index: 9 })).toEqual({
      kind: "cancel",
    });
  });

  test("id string index preferred when valid", () => {
    const opts = ["A", "B", "C"];
    expect(operatorResultFromSelection(opts, { index: 0, id: "2" })).toEqual({
      kind: "option",
      index: 2,
    });
    // non-decimal / out of range id ignored → use index
    expect(operatorResultFromSelection(opts, { index: 1, id: "nope" })).toEqual({
      kind: "option",
      index: 1,
    });
  });

  test("cancel / custom constructors", () => {
    expect(operatorCancelResult()).toEqual({ kind: "cancel" });
    expect(operatorCustomResult("typed")).toEqual({
      kind: "custom",
      text: "typed",
    });
  });
});

describe("wireGates", () => {
  test("subscribes exactly permission.gate and operator.gate; dispose removes both", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      try {
        const dispose = wireGates(emitter, shell);
        expect(emitter.listenerCount("permission.gate")).toBe(1);
        expect(emitter.listenerCount("operator.gate")).toBe(1);

        dispose();
        expect(emitter.listenerCount("permission.gate")).toBe(0);
        expect(emitter.listenerCount("operator.gate")).toBe(0);
      } finally {
        shell.dispose();
      }
    });
  });

  test("permission.gate opens overlay and resolves selection through onAccept", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      let resolved: unknown;
      const request: PermissionRequest = {
        tool: "run_shell",
        action: "Run shell command",
        subject: "bun test",
        scopes: [],
      };
      try {
        const dispose = wireGates(emitter, shell);
        emitter.emit("permission.gate", {
          request,
          resolve: (outcome: unknown) => {
            resolved = outcome;
          },
        });
        expect(shell.overlayKind).toBe("permissions");
        expect(shell.overlayItems).toEqual(["Reject", "Accept once"]);

        acceptOverlaySelection(shell);
        expect(resolved).toEqual({ allow: false });

        dispose();
      } finally {
        shell.dispose();
      }
    });
  });

  test("permission.gate paints the collapsed body and expands it on toggle", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 100, rows: 40 },
          run: "idle",
        });
        const emitter = new EventEmitter();
        const request: PermissionRequest = {
          tool: "run_shell",
          action: "Run shell command",
          subject: "echo start && cat > notes.txt <<EOF\nalpha\nbeta\nEOF",
          scopes: [],
        };
        try {
          const dispose = wireGates(emitter, shell);
          emitter.emit("permission.gate", { request, resolve: () => {} });

          const collapsed = shell.overlayBodyLines.join("\n");
          expect(collapsed).toContain("1) echo start");
          expect(collapsed).toContain("<heredoc, 2 lines>");
          expect(collapsed).not.toContain("alpha");

          expect(toggleOverlayExpand(shell)).toBe(true);
          const expanded = shell.overlayBodyLines.join("\n");
          expect(expanded).toContain("<heredoc, 2 lines>");
          expect(expanded).toContain("alpha");
          expect(expanded).toContain("beta");

          // Full text also lands in the scrollable transcript, which no
          // overlay height cap can clip.
          const dumped = shell.streamLog.filter((r) => r.text.includes("alpha"));
          expect(dumped.length).toBeGreaterThan(0);
          for (const row of dumped) {
            expect(row.meta).toBeUndefined();
            expect(streamRowGutter(row, { width: 80, multiAgent: false }).content).toBe("");
          }

          expect(toggleOverlayExpand(shell)).toBe(true);
          expect(shell.overlayBodyLines.join("\n")).not.toContain("alpha");

          dispose();
        } finally {
          shell.dispose();
        }
      },
      { width: 100, height: 40 },
    );
  });

  test("operator.gate opens overlay and resolves selection through onAccept", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      let resolved: unknown;
      try {
        const dispose = wireGates(emitter, shell);
        emitter.emit("operator.gate", {
          question: "Proceed?",
          options: ["Cancel", "Continue"],
          resolve: (result: unknown) => {
            resolved = result;
          },
        });
        expect(shell.overlayKind).toBe("operator");
        expect(shell.overlayItems).toEqual(["Cancel", "Continue"]);

        acceptOverlaySelection(shell);
        expect(resolved).toEqual({ kind: "option", index: 0 });

        dispose();
      } finally {
        shell.dispose();
      }
    });
  });

  test("gate decisions do not replay the request into the transcript", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 96, rows: 30 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      const request: PermissionRequest = {
        tool: "run_shell",
        action: "Run shell command",
        subject: "ls -la ~/.corbits/projects",
        scopes: [],
      };
      try {
        const dispose = wireGates(emitter, shell);
        emitter.emit("permission.gate", { request, resolve: () => {} });

        expect(shell.streamLog.filter((r) => r.meta === "permission")).toHaveLength(0);

        acceptOverlaySelection(shell);

        expect(shell.streamLog.filter((r) => r.meta === "permission")).toHaveLength(0);

        dispose();
      } finally {
        shell.dispose();
      }
    });
  });
});

describe("gate decisions stay out of the transcript", () => {
  test("permission accept", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      try {
        wireGates(emitter, shell);
        emitter.emit("permission.gate", { request: baseRequest(), resolve: () => {} });

        const before = shell.streamLog.length;
        acceptOverlaySelection(shell);
        expect(shell.streamLog.length - before).toBe(0);
      } finally {
        shell.dispose();
      }
    });
  });

  test("permission Esc/deny", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      try {
        wireGates(emitter, shell);
        emitter.emit("permission.gate", { request: baseRequest(), resolve: () => {} });

        const before = shell.streamLog.length;
        closeInsetOverlay(shell);
        expect(shell.streamLog.length - before).toBe(0);
      } finally {
        shell.dispose();
      }
    });
  });

  test("operator accept", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      try {
        wireGates(emitter, shell);
        emitter.emit("operator.gate", {
          question: "Proceed?",
          options: ["Cancel", "Continue"],
          resolve: () => {},
        });

        const before = shell.streamLog.length;
        acceptOverlaySelection(shell);
        expect(shell.streamLog.length - before).toBe(0);
      } finally {
        shell.dispose();
      }
    });
  });

  test("operator Esc/cancel", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      try {
        wireGates(emitter, shell);
        emitter.emit("operator.gate", {
          question: "Proceed?",
          options: ["Cancel", "Continue"],
          resolve: () => {},
        });

        const before = shell.streamLog.length;
        closeInsetOverlay(shell);
        expect(shell.streamLog.length - before).toBe(0);
      } finally {
        shell.dispose();
      }
    });
  });

  test("operator typed answer", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      try {
        wireGates(emitter, shell);
        emitter.emit("operator.gate", {
          question: "Proceed?",
          options: ["Cancel", "Continue"],
          resolve: () => {},
        });

        setOverlayAnswerActive(shell, true);
        const before = shell.streamLog.length;
        for (const ch of "yes") {
          handleOverlayAnswerKey(shell, {
            name: ch,
            sequence: ch,
            ctrl: false,
            meta: false,
            option: false,
          } as unknown as KeyEvent);
        }
        handleOverlayAnswerKey(shell, {
          name: "return",
          sequence: "",
          ctrl: false,
          meta: false,
          option: false,
        } as unknown as KeyEvent);
        expect(shell.streamLog.length - before).toBe(0);
      } finally {
        shell.dispose();
      }
    });
  });

  test("permission auto-deny on timeout", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      try {
        wireGates(emitter, shell);
        const before = shell.streamLog.length;
        emitter.emit("permission.gate", {
          request: baseRequest(),
          resolve: () => {},
          timeoutMs: 5,
        });
        await new Promise((r) => setTimeout(r, 20));
        expect(shell.streamLog.length - before).toBe(0);
      } finally {
        shell.dispose();
      }
    });
  });

  test("permission auto-deny on abort", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      const controller = new AbortController();
      try {
        wireGates(emitter, shell);
        const before = shell.streamLog.length;
        emitter.emit("permission.gate", {
          request: baseRequest(),
          resolve: () => {},
          signal: controller.signal,
        });
        controller.abort();
        expect(shell.streamLog.length - before).toBe(0);
      } finally {
        shell.dispose();
      }
    });
  });

  // The queue's settle-once guard is independent of the transcript: racing a
  // timeout against an abort on the same request exercises that guard.
  // clearTimers must retire the loser before it can run autoDeny a second
  // time, so ev.resolve fires exactly once no matter which trigger wins, and
  // neither path writes a recap row.
  test("a timeout and an abort racing the same request settle once", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      const controller = new AbortController();
      let resolveCount = 0;
      try {
        wireGates(emitter, shell);
        const before = shell.streamLog.length;
        emitter.emit("permission.gate", {
          request: baseRequest(),
          resolve: () => {
            resolveCount += 1;
          },
          timeoutMs: 5,
          signal: controller.signal,
        });

        await new Promise((r) => setTimeout(r, 20));
        // The timeout already fired and cleared the abort listener — this
        // must be a no-op, not a second settle.
        controller.abort();

        expect(resolveCount).toBe(1);
        expect(shell.streamLog.length - before).toBe(0);
      } finally {
        shell.dispose();
      }
    });
  });

  test("a queued gate's timeout settles once, only after it is displayed", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      let resolveCount = 0;
      try {
        wireGates(emitter, shell);
        emitter.emit("permission.gate", {
          request: baseRequest(),
          resolve: () => {},
        });
        const before = shell.streamLog.length;
        emitter.emit("permission.gate", {
          request: baseRequest({ tool: "queued_tool" }),
          resolve: () => {
            resolveCount += 1;
          },
          timeoutMs: 5,
        });

        // Still behind the first gate — the timeout must not be ticking yet.
        await new Promise((r) => setTimeout(r, 20));
        expect(resolveCount).toBe(0);
        expect(shell.streamLog.length).toBe(before);

        // Closing the first gate displays the queued one, arming its timer.
        acceptOverlaySelection(shell);
        await new Promise((r) => setTimeout(r, 20));

        expect(resolveCount).toBe(1);
        expect(shell.streamLog.length - before).toBe(0); // first gate + queued timeout both silent
      } finally {
        shell.dispose();
      }
    });
  });

  // reconcile() (src/permission/queue.ts) settles a queued request directly
  // when a grant covers it, with no accept/cancel/autoDeny callback of its
  // own. Coverage here is that the queued request still resolves, without
  // ever opening and without writing a recap row.
  test("a grant draining a queued request without ever displaying it", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      let resolveCount = 0;
      let resolved: unknown;
      try {
        wireGates(emitter, shell);
        // Occupies the overlay host so the second request queues instead of
        // opening — the drain below must resolve it without ever opening it.
        emitter.emit("permission.gate", {
          request: baseRequest(),
          resolve: () => {},
        });
        const before = shell.streamLog.length;
        emitter.emit("permission.gate", {
          request: baseRequest({ tool: "queued_tool" }),
          resolve: (outcome: unknown) => {
            resolveCount += 1;
            resolved = outcome;
          },
        });

        emitter.emit("permission.grant", {
          approval: { tool: "queued_tool", pattern: "bun test" },
          covers: (r: { tool: string }) => r.tool === "queued_tool",
        });

        expect(resolveCount).toBe(1);
        expect(resolved).toEqual({ allow: true });
        expect(shell.streamLog.length - before).toBe(0);
      } finally {
        shell.dispose();
      }
    });
  });

  test("a grant draining the currently displayed request closes it without a recap", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      let resolveCount = 0;
      try {
        wireGates(emitter, shell);
        const before = shell.streamLog.length;
        emitter.emit("permission.gate", {
          request: baseRequest(),
          resolve: () => {
            resolveCount += 1;
          },
        });
        expect(shell.overlayKind).toBe("permissions");

        emitter.emit("permission.grant", {
          approval: { tool: "run_shell", pattern: "bun test" },
          covers: () => true,
        });

        expect(resolveCount).toBe(1);
        expect(shell.overlayList).toBeNull();
        expect(shell.streamLog.length - before).toBe(0);
      } finally {
        shell.dispose();
      }
    });
  });

  // drain() (src/permission/queue.ts) denies whatever is still queued on
  // teardown — the same no-call-site path as a grant drain, but the
  // opposite outcome. Coverage is the deny itself; neither path writes a
  // recap row.
  test("disposing with a request still queued denies it without a recap", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      // The currently-open request has no accept/cancel/autoDeny call site
      // triggered before teardown either, so dispose must settle it too —
      // both entries go through drain() without writing a recap.
      let openResolveCount = 0;
      let queuedResolveCount = 0;
      let queuedResolved: unknown;
      const dispose = wireGates(emitter, shell);
      emitter.emit("permission.gate", {
        request: baseRequest(),
        resolve: () => {
          openResolveCount += 1;
        },
      });
      // Occupies the overlay host so this second request queues instead of
      // opening — dispose must deny it without ever displaying it.
      const before = shell.streamLog.length;
      emitter.emit("permission.gate", {
        request: baseRequest({ tool: "queued_tool" }),
        resolve: (outcome: unknown) => {
          queuedResolveCount += 1;
          queuedResolved = outcome;
        },
      });

      dispose();

      expect(openResolveCount).toBe(1);
      expect(queuedResolveCount).toBe(1);
      expect(queuedResolved).toEqual({ allow: false });
      expect(shell.streamLog.length - before).toBe(0);
      shell.dispose();
    });
  });
});

describe("permission.gate auto-deny", () => {
  test("timeoutMs elapsing auto-denies with the timeout message and closes the overlay", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      let resolved: unknown;
      try {
        wireGates(emitter, shell);
        emitter.emit("permission.gate", {
          request: baseRequest(),
          resolve: (outcome: unknown) => {
            resolved = outcome;
          },
          timeoutMs: 5,
          timeoutMessage: "auto-deny: no answer in time",
        });
        expect(shell.overlayKind).toBe("permissions");

        await new Promise((r) => setTimeout(r, 20));

        expect(resolved).toEqual({
          allow: false,
          message: "auto-deny: no answer in time",
        });
        expect(shell.overlayList).toBeNull();
      } finally {
        shell.dispose();
      }
    });
  });

  test("aborting the signal while the overlay is open auto-denies and closes it", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      const controller = new AbortController();
      let resolved: unknown;
      try {
        wireGates(emitter, shell);
        emitter.emit("permission.gate", {
          request: baseRequest(),
          resolve: (outcome: unknown) => {
            resolved = outcome;
          },
          signal: controller.signal,
        });
        expect(shell.overlayKind).toBe("permissions");

        controller.abort();

        expect(resolved).toEqual({
          allow: false,
          message: "tool no longer running; permission request denied",
        });
        expect(shell.overlayList).toBeNull();
      } finally {
        shell.dispose();
      }
    });
  });

  test("resolving normally clears the timer instead of firing it later", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      let resolveCount = 0;
      let lastOutcome: unknown;
      try {
        wireGates(emitter, shell);
        emitter.emit("permission.gate", {
          request: baseRequest(),
          resolve: (outcome: unknown) => {
            resolveCount += 1;
            lastOutcome = outcome;
          },
          timeoutMs: 10,
        });

        acceptOverlaySelection(shell);
        expect(resolveCount).toBe(1);
        expect(lastOutcome).toEqual({ allow: false });

        await new Promise((r) => setTimeout(r, 25));
        expect(resolveCount).toBe(1);
      } finally {
        shell.dispose();
      }
    });
  });

  test("a queued gate's timeout does not start until it is displayed", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      let firstResolved: unknown;
      let secondResolved: unknown;
      try {
        wireGates(emitter, shell);
        emitter.emit("permission.gate", {
          request: baseRequest(),
          resolve: (outcome: unknown) => {
            firstResolved = outcome;
          },
        });
        emitter.emit("permission.gate", {
          request: baseRequest({ tool: "queued_tool" }),
          resolve: (outcome: unknown) => {
            secondResolved = outcome;
          },
          timeoutMs: 5,
          timeoutMessage: "queued gate timed out",
        });
        // Second gate has not opened yet — it is waiting behind the first.
        expect(shell.overlayKind).toBe("permissions");

        // Well past the nominal 5ms timeout — the queued gate must survive
        // this because it has never been shown to the operator.
        await new Promise((r) => setTimeout(r, 20));
        expect(secondResolved).toBeUndefined();
        expect(firstResolved).toBeUndefined();
        expect(shell.overlayKind).toBe("permissions");

        // Closing the first gate displays the second, which arms its timer
        // only now — this is when the queued gate's clock should start.
        acceptOverlaySelection(shell);
        expect(firstResolved).toEqual({ allow: false });
        expect(secondResolved).toBeUndefined();

        await new Promise((r) => setTimeout(r, 20));
        expect(secondResolved).toEqual({
          allow: false,
          message: "queued gate timed out",
        });
        expect(shell.overlayList).toBeNull();
      } finally {
        shell.dispose();
      }
    });
  });
});

describe("operator.gate auto-cancel", () => {
  test("timeoutMs elapsing auto-cancels with the timeout label and closes the overlay", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      let resolved: unknown;
      try {
        wireGates(emitter, shell);
        emitter.emit("operator.gate", {
          question: "Proceed?",
          options: ["Yes", "No"],
          resolve: (result: unknown) => {
            resolved = result;
          },
          timeoutMs: 5,
          timeoutMessage: "auto-cancel: no answer in time",
        });
        expect(shell.overlayKind).toBe("operator");

        await new Promise((r) => setTimeout(r, 20));

        expect(resolved).toEqual(operatorCancelResult());
        expect(shell.overlayList).toBeNull();
      } finally {
        shell.dispose();
      }
    });
  });

  test("aborting the signal while the overlay is open auto-cancels and closes it", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      const controller = new AbortController();
      let resolved: unknown;
      try {
        wireGates(emitter, shell);
        emitter.emit("operator.gate", {
          question: "Proceed?",
          options: ["Yes", "No"],
          resolve: (result: unknown) => {
            resolved = result;
          },
          signal: controller.signal,
        });
        expect(shell.overlayKind).toBe("operator");

        controller.abort();

        expect(resolved).toEqual(operatorCancelResult());
        expect(shell.overlayList).toBeNull();
      } finally {
        shell.dispose();
      }
    });
  });

  // The queue-behind hazard from CL-5664: a stuck overlay in front of an
  // ask_operator question must not hang the run forever with nothing on
  // screen to answer. The abort listener is not display-dependent, so it
  // must settle the queued gate even though it never opened.
  test("aborting the run while the operator gate is still queued settles it without ever opening", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      const controller = new AbortController();
      let resolved: unknown;
      try {
        wireGates(emitter, shell);
        emitter.emit("permission.gate", {
          request: baseRequest(),
          resolve: () => {},
        });
        emitter.emit("operator.gate", {
          question: "Proceed?",
          options: ["Yes", "No"],
          resolve: (result: unknown) => {
            resolved = result;
          },
          signal: controller.signal,
        });
        // Still queued behind the permission overlay.
        expect(shell.overlayKind).toBe("permissions");

        controller.abort();

        expect(resolved).toEqual(operatorCancelResult());
        // The permission overlay in front is undisturbed.
        expect(shell.overlayKind).toBe("permissions");
      } finally {
        shell.dispose();
      }
    });
  });

  test("a queued operator gate's timeout does not start until it is displayed", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      let firstResolved: unknown;
      let secondResolved: unknown;
      try {
        wireGates(emitter, shell);
        emitter.emit("permission.gate", {
          request: baseRequest(),
          resolve: (outcome: unknown) => {
            firstResolved = outcome;
          },
        });
        emitter.emit("operator.gate", {
          question: "Proceed?",
          options: ["Yes", "No"],
          resolve: (result: unknown) => {
            secondResolved = result;
          },
          timeoutMs: 5,
          timeoutMessage: "queued operator gate timed out",
        });
        expect(shell.overlayKind).toBe("permissions");

        // Well past the nominal 5ms timeout — must survive because it has
        // never been shown to the operator.
        await new Promise((r) => setTimeout(r, 20));
        expect(secondResolved).toBeUndefined();

        acceptOverlaySelection(shell);
        expect(firstResolved).toEqual({ allow: false });
        expect(secondResolved).toBeUndefined();
        expect(shell.overlayKind).toBe("operator");

        await new Promise((r) => setTimeout(r, 20));
        expect(secondResolved).toEqual(operatorCancelResult());
        expect(shell.overlayList).toBeNull();
      } finally {
        shell.dispose();
      }
    });
  });

  test("resolving normally clears the timer instead of firing it later", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      let resolveCount = 0;
      try {
        wireGates(emitter, shell);
        emitter.emit("operator.gate", {
          question: "Proceed?",
          options: ["Yes", "No"],
          resolve: () => {
            resolveCount += 1;
          },
          timeoutMs: 10,
        });

        acceptOverlaySelection(shell);
        expect(resolveCount).toBe(1);

        await new Promise((r) => setTimeout(r, 25));
        expect(resolveCount).toBe(1);
      } finally {
        shell.dispose();
      }
    });
  });

  test("each terminal path settles without writing a transcript row", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      try {
        wireGates(emitter, shell);
        const before = shell.streamLog.length;
        emitter.emit("operator.gate", {
          question: "Proceed?",
          options: ["Yes", "No"],
          resolve: () => {},
          timeoutMs: 5,
        });
        await new Promise((r) => setTimeout(r, 20));
        expect(shell.streamLog.length - before).toBe(0);
      } finally {
        shell.dispose();
      }
    });
  });

  // Mirrors the permission queue's "disposing with a request still queued"
  // coverage: unlike permissionQueue, the operator gate has no queue module
  // of its own, so wireGates must track outstanding operator gates itself to
  // settle them on teardown.
  test("disposing with a gate still queued settles it instead of hanging", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      let openResolved: unknown;
      let queuedResolved: unknown;
      const dispose = wireGates(emitter, shell);
      emitter.emit("operator.gate", {
        question: "Proceed?",
        options: ["Yes", "No"],
        resolve: (r: unknown) => {
          openResolved = r;
        },
      });
      // Occupies the overlay host so this second gate queues instead of
      // opening — dispose must cancel it without ever displaying it.
      const before = shell.streamLog.length;
      emitter.emit("operator.gate", {
        question: "Also proceed?",
        options: ["Yes", "No"],
        resolve: (r: unknown) => {
          queuedResolved = r;
        },
      });

      dispose();

      expect(openResolved).toEqual(operatorCancelResult());
      expect(queuedResolved).toEqual(operatorCancelResult());
      expect(shell.streamLog.length - before).toBe(0);
      shell.dispose();
    });
  });
});

describe("Esc on a gate overlay settles the awaited promise", () => {
  test("permission.gate: Esc denies instead of abandoning the promise", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      let resolved: unknown;
      let resolveCount = 0;
      try {
        wireGates(emitter, shell);
        emitter.emit("permission.gate", {
          request: baseRequest(),
          resolve: (outcome: unknown) => {
            resolveCount += 1;
            resolved = outcome;
          },
        });
        expect(shell.overlayKind).toBe("permissions");

        closeInsetOverlay(shell);

        expect(shell.overlayList).toBeNull();
        expect(resolveCount).toBe(1);
        expect(resolved).toEqual({ allow: false });
      } finally {
        shell.dispose();
      }
    });
  });

  test("operator.gate: Esc cancels instead of abandoning the promise", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      });
      const emitter = new EventEmitter();
      let resolved: unknown;
      let resolveCount = 0;
      try {
        wireGates(emitter, shell);
        emitter.emit("operator.gate", {
          question: "Proceed?",
          options: ["Cancel", "Continue"],
          resolve: (result: unknown) => {
            resolveCount += 1;
            resolved = result;
          },
        });
        expect(shell.overlayKind).toBe("operator");

        closeInsetOverlay(shell);

        expect(shell.overlayList).toBeNull();
        expect(resolveCount).toBe(1);
        expect(resolved).toEqual({ kind: "cancel" });
      } finally {
        shell.dispose();
      }
    });
  });
});

describe("permission overlay height", () => {
  const openGate = (shell: AppShell, scopeCount: number): void => {
    const emitter = new EventEmitter();
    wireGates(emitter, shell);
    emitter.emit("permission.gate", {
      request: {
        tool: "run_shell",
        action: "Run shell command",
        subject: "ls -la ~/.corbits/projects 2>/dev/null | head -40",
        scopes: Array.from({ length: scopeCount }, (_, i) => ({
          id: `s${i}`,
          label: `Always allow scope ${i}`,
          pattern: `p${i}`,
        })),
      },
      resolve: () => {},
    });
  };

  const hostRowsFor = async (rows: number, scopeCount: number): Promise<number> => {
    let height = -1;
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 96, rows },
          run: "idle",
        });
        try {
          openGate(shell, scopeCount);
          height = shell.layout.heights.overlay_host;
        } finally {
          shell.dispose();
        }
      },
      { width: 96, height: rows },
    );
    return height;
  };

  test("tracks item count, not terminal height", async () => {
    const short = await hostRowsFor(30, 1);
    const tall = await hostRowsFor(60, 1);
    expect(short).toBe(tall);

    // Two extra choices cost exactly four extra rows: each choice occupies
    // two rows (wrap padding), so the list is a simple multiple of item count.
    expect(await hostRowsFor(60, 3)).toBe(tall + 4);
  });

  test("caps rather than growing, and the list scrolls inside the cap", async () => {
    const rows = 40;
    const capped = await hostRowsFor(rows, 40);
    expect(capped).toBeLessThanOrEqual(Math.floor(rows * OVERLAY_MAX_FRACTION));
    // Capped means the viewport holds fewer items than exist, not that rows
    // spill outside the host.
    expect(capped).toBeLessThan((await hostRowsFor(rows, 1)) + 40);
  });
});

describe("operator question overlay", () => {
  const emitOperator = (
    shell: AppShell,
    options: readonly string[],
    onResolve: (result: unknown) => void,
  ): void => {
    const emitter = new EventEmitter();
    wireGates(emitter, shell);
    emitter.emit("operator.gate", {
      question: "Scope for this run is still <SCOPE>. What should it be?",
      options: [...options],
      resolve: onResolve,
    });
  };

  const keyOf = (seq: string, name?: string): KeyEvent =>
    ({
      name: name ?? seq,
      sequence: seq,
      ctrl: false,
      meta: false,
      option: false,
    }) as unknown as KeyEvent;

  const withOperator = async (
    rows: number,
    options: readonly string[],
    body: (h: Harness, shell: AppShell, resolved: () => unknown) => void | Promise<void>,
  ): Promise<void> => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 96, rows },
          run: "idle",
        });
        let resolved: unknown = undefined;
        try {
          emitOperator(shell, options, (r) => {
            resolved = r;
          });
          await body(h, shell, () => resolved);
        } finally {
          shell.dispose();
        }
      },
      { width: 96, height: rows },
    );
  };

  const frameOf = async (h: Harness): Promise<string> => {
    await h.renderOnce();
    await h.renderOnce();
    return h.captureCharFrame();
  };

  for (const rows of [24, 60]) {
    test(`several options render and resolve by index at ${rows} rows`, async () => {
      await withOperator(rows, ["repo only", "docs too", "everything"], (h, shell, resolved) => {
        expect(shell.overlayKind).toBe("operator");
        expect(shell.overlayItems).toEqual(["repo only", "docs too", "everything"]);
        moveOverlaySelection(shell, 1);
        acceptOverlaySelection(shell);
        expect(resolved()).toEqual({ kind: "option", index: 1 });
        void h;
      });
    });

    test(`a single option still renders a choosable row at ${rows} rows`, async () => {
      await withOperator(rows, ["only this"], (h, shell, resolved) => {
        expect(shell.overlayItems).toEqual(["only this"]);
        acceptOverlaySelection(shell);
        expect(resolved()).toEqual({ kind: "option", index: 0 });
        void h;
      });
    });

    test(`no options opens straight into the answer field at ${rows} rows`, async () => {
      await withOperator(rows, [], async (h, shell, resolved) => {
        expect(shell.overlayKind).toBe("operator");
        expect(shell.overlayItems).toEqual([]);
        const frame = await frameOf(h);
        // Never offer a chooser with nothing to choose.
        expect(frame).not.toContain("Enter choose");
        expect(frame).toContain("Enter send");
        expect(frame).toContain("answer>");
        // Enter with nothing typed must not resolve the gate at all.
        acceptOverlaySelection(shell);
        expect(resolved()).toBeUndefined();
      });
    });
  }

  test("the answer field is advertised on screen next to the choices", async () => {
    await withOperator(40, ["repo only", "everything"], async (h) => {
      const frame = await frameOf(h);
      expect(frame).toContain("Tab type an answer");
      expect(frame).toContain("type your own answer");
    });
  });

  test("a typed answer round-trips as a custom OperatorResult", async () => {
    await withOperator(40, ["repo only", "everything"], (h, shell, resolved) => {
      expect(setOverlayAnswerActive(shell, true)).toBe(true);
      for (const ch of "src and docs") {
        expect(handleOverlayAnswerKey(shell, keyOf(ch))).toBe(true);
      }
      expect(handleOverlayAnswerKey(shell, keyOf("x", "backspace"))).toBe(true);
      expect(handleOverlayAnswerKey(shell, keyOf("", "return"))).toBe(true);
      expect(resolved()).toEqual({ kind: "custom", text: "src and doc" });
      // Submitting closes the overlay, so the host is free for the next gate.
      expect(shell.overlayList).toBeNull();
      void h;
    });
  });

  test("Esc in the answer field returns to the choices instead of cancelling", async () => {
    await withOperator(40, ["repo only"], (h, shell, resolved) => {
      setOverlayAnswerActive(shell, true);
      expect(exitOverlayAnswerMode(shell)).toBe(true);
      expect(shell.overlayList).not.toBeNull();
      expect(resolved()).toBeUndefined();
      void h;
    });
  });

  test("a gate arriving while another overlay is open opens once that one closes", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 96, rows: 40 },
          run: "idle",
        });
        const emitter = new EventEmitter();
        let approved: unknown = undefined;
        let answered: unknown = undefined;
        try {
          wireGates(emitter, shell);
          emitter.emit("permission.gate", {
            request: baseRequest(),
            resolve: (o: unknown) => {
              approved = o;
            },
          });
          emitter.emit("operator.gate", {
            question: "Scope for this run?",
            options: ["repo only"],
            resolve: (r: unknown) => {
              answered = r;
            },
          });
          expect(shell.overlayKind).toBe("permissions");

          acceptOverlaySelection(shell);
          expect(approved).toEqual({ allow: false });
          // The queued question is not lost: it takes the host as it frees up.
          expect(shell.overlayKind).toBe("operator");
          acceptOverlaySelection(shell);
          expect(answered).toEqual({ kind: "option", index: 0 });
        } finally {
          shell.dispose();
        }
      },
      { width: 96, height: 40 },
    );
  });
});
