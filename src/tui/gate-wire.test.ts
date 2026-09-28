/**
 * Pure gate-wire unit tests — no renderer.
 */
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "../permission/types.js";
import type { KeyEvent } from "@opentui/core";
import {
  withTestRenderer,
  type Harness,
  type HarnessOptions,
} from "./harness.js";
import { OVERLAY_MAX_FRACTION } from "./geometry/index.js";
import { createAppShell } from "./shell/index.js";
import type { AppShell } from "./shell/internals.js";
import {
  acceptOverlaySelection,
  closeInsetOverlay,
  exitOverlayAnswerMode,
  handleOverlayAnswerKey,
  setOverlayAnswerActive,
} from "./shell/overlay-host.js";
import {
  moveOverlaySelection,
  toggleOverlayExpand,
} from "./shell/overlay-list.js";
import { streamRowGutter } from "./stream.js";
import {
  APPROVAL_UNAVAILABLE_MESSAGE,
  type OperatorGateEvent,
  type PermissionGateEvent,
} from "./gate-events.js";
import { SESSION_IDENTITY_ABORT_REASON } from "./delivery-queue.js";
import {
  approvalOutcomeFromSelection,
  operatorCancelResult,
  operatorChoicesFromOptions,
  operatorResultFromSelection,
  PERMISSION_DENY_ID,
  PERMISSION_ONCE_ID,
  permissionBodyFromRequest,
  permissionChoicesFromRequest,
  wireGates,
} from "./gate-wire.js";

const baseRequest = (
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest => ({
  tool: "run_shell",
  action: "Run shell command",
  subject: "bun test",
  scopes: [],
  ...overrides,
});

const unavailable = { allow: false, message: APPROVAL_UNAVAILABLE_MESSAGE };

type GateCtx = {
  readonly h: Harness;
  readonly shell: AppShell;
  readonly emitter: EventEmitter;
  readonly disposeGates: () => void;
};

type GateOpts = {
  readonly terminal?: { readonly columns: number; readonly rows: number };
  readonly renderer?: HarnessOptions;
};

async function withGates(
  fn: (ctx: GateCtx) => Promise<void> | void,
  opts: GateOpts = {},
): Promise<void> {
  const terminal = opts.terminal ?? { columns: 80, rows: 24 };
  await withTestRenderer(async (h) => {
    const shell = createAppShell(h.renderer, { terminal, run: "idle" });
    const emitter = new EventEmitter();
    const disposeGates = wireGates(emitter, shell);
    try {
      await fn({ h, shell, emitter, disposeGates });
    } finally {
      disposeGates();
      shell.dispose();
    }
  }, opts.renderer);
}

function emitPermission(
  emitter: EventEmitter,
  overrides: Omit<Partial<PermissionGateEvent>, "id"> & {
    readonly id?: string | undefined;
  } = {},
): void {
  emitter.emit("permission.gate", {
    id: "req-1",
    request: baseRequest(),
    resolve: () => undefined,
    ...overrides,
  });
}

function emitOperator(
  emitter: EventEmitter,
  overrides: Omit<Partial<OperatorGateEvent>, "id"> & {
    readonly id?: string | undefined;
  } = {},
): void {
  emitter.emit("operator.gate", {
    id: "ask-1",
    question: "Proceed?",
    options: ["Cancel", "Continue"],
    resolve: () => undefined,
    ...overrides,
  });
}

describe("permissionChoicesFromRequest", () => {
  test("always includes reject + accept once", () => {
    const choices = permissionChoicesFromRequest(baseRequest(), "req-1");
    expect(choices.items).toEqual(["Reject", "Accept once"]);
    expect(choices.itemIds).toEqual([
      `req-1:${PERMISSION_DENY_ID}`,
      `req-1:${PERMISSION_ONCE_ID}`,
    ]);
    expect(choices.outcomes).toEqual([{ allow: false }, { allow: true }]);
  });

  test("appends scopes as bare labels; persist only when pattern set", () => {
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
      "req-1",
    );
    expect(choices.items).toEqual([
      "Reject",
      "Accept once",
      "Allow git *",
      "Allow this path",
    ]);
    expect(choices.itemIds).toEqual([
      `req-1:${PERMISSION_DENY_ID}`,
      `req-1:${PERMISSION_ONCE_ID}`,
      "req-1:session-git",
      "req-1:once-extra",
    ]);
    expect(choices.outcomes[2]).toEqual({
      allow: true,
      persist: scopeWithPattern,
    });
    expect(choices.outcomes[3]).toEqual({ allow: true });
  });
});

describe("approvalOutcomeFromSelection", () => {
  test("id maps to parallel outcomes; omitted or unknown id is unavailable", () => {
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
      "req-1",
    );
    expect(
      approvalOutcomeFromSelection(choices, {
        index: 0,
        id: `req-1:${PERMISSION_DENY_ID}`,
      }),
    ).toEqual({
      allow: false,
    });
    expect(
      approvalOutcomeFromSelection(choices, {
        index: 0,
        id: `req-1:${PERMISSION_ONCE_ID}`,
      }),
    ).toEqual({
      allow: true,
    });
    expect(
      approvalOutcomeFromSelection(choices, { index: 0, id: "req-1:proj" })
        .allow,
    ).toBe(true);
    expect(
      approvalOutcomeFromSelection(choices, { index: 0, id: "req-1:proj" })
        .persist?.id,
    ).toBe("proj");
    expect(approvalOutcomeFromSelection(choices, { index: 0 })).toEqual(
      unavailable,
    );
    expect(approvalOutcomeFromSelection(choices, { index: 99 })).toEqual(
      unavailable,
    );
  });

  test("id preferred over index when present", () => {
    const choices = permissionChoicesFromRequest(
      baseRequest({
        scopes: [
          { id: "a", label: "A", pattern: "a*" },
          { id: "b", label: "B", pattern: "b*" },
        ],
      }),
      "req-1",
    );
    const byId = approvalOutcomeFromSelection(choices, {
      index: 0,
      id: "req-1:b",
    });
    expect(byId.allow).toBe(true);
    expect(byId.persist?.id).toBe("b");
  });

  test("unknown id is unavailable without falling back to index", () => {
    const choices = permissionChoicesFromRequest(baseRequest(), "req-1");
    expect(
      approvalOutcomeFromSelection(choices, {
        index: 1,
        id: "missing",
      }),
    ).toEqual(unavailable);
  });
});

describe("permissionBodyFromRequest", () => {
  test("joins tool/action/subject and optional agent/notice", () => {
    expect(permissionBodyFromRequest(baseRequest())).toBe(
      "run_shell\nRun shell command\nbun test",
    );
    expect(
      permissionBodyFromRequest(
        baseRequest({
          agentLabel: "explorer",
          notice: "mega-chain",
        }),
      ),
    ).toBe(
      "run_shell\nRun shell command\nbun test\nagent: explorer\nmega-chain",
    );
  });

  test("scope hints paint in the body above the choices, collapsed and expanded", () => {
    const request = baseRequest({
      scopes: [
        {
          id: "always",
          label: "Allow always",
          pattern: "rm -rf *",
          hint: "deletes generated output before the next build starts",
        },
        { id: "once", label: "Allow once", pattern: null },
      ],
    });
    for (const opts of [{}, { expanded: true } as const]) {
      const body = permissionBodyFromRequest(request, opts);
      expect(body).toContain(
        "Allow always: deletes generated output before the next build starts",
      );
    }
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
  test("choices mirror options with ask-scoped ids", () => {
    const opts = ["Cancel", "Option A", "Option B"];
    const choices = operatorChoicesFromOptions(opts, "ask-1");
    expect(choices.items).toEqual(opts);
    expect(choices.itemIds).toEqual(["ask-1:0", "ask-1:1", "ask-1:2"]);
  });

  test("selection id → option; omitted or unknown id → cancel", () => {
    const choices = operatorChoicesFromOptions(["A", "B"], "ask-1");
    expect(
      operatorResultFromSelection(choices, { index: 0, id: "ask-1:0" }),
    ).toEqual({
      kind: "option",
      index: 0,
    });
    expect(
      operatorResultFromSelection(choices, { index: 1, id: "ask-1:1" }),
    ).toEqual({
      kind: "option",
      index: 1,
    });
    expect(operatorResultFromSelection(choices, { index: 0 })).toEqual({
      kind: "cancel",
    });
    expect(operatorResultFromSelection(choices, { index: 9 })).toEqual({
      kind: "cancel",
    });
  });

  test("id preferred when present in itemIds", () => {
    const choices = operatorChoicesFromOptions(["A", "B", "C"], "ask-1");
    expect(
      operatorResultFromSelection(choices, { index: 0, id: "ask-1:2" }),
    ).toEqual({
      kind: "option",
      index: 2,
    });
    expect(
      operatorResultFromSelection(choices, { index: 1, id: "nope" }),
    ).toEqual({
      kind: "cancel",
    });
    expect(operatorResultFromSelection(choices, { index: 1, id: "2" })).toEqual(
      {
        kind: "cancel",
      },
    );
  });
});

describe("wireGates", () => {
  test("subscribes exactly permission.gate and operator.gate; dispose removes both", async () => {
    await withGates(async ({ emitter, disposeGates }) => {
      expect(emitter.listenerCount("permission.gate")).toBe(1);
      expect(emitter.listenerCount("operator.gate")).toBe(1);

      disposeGates();
      expect(emitter.listenerCount("permission.gate")).toBe(0);
      expect(emitter.listenerCount("operator.gate")).toBe(0);
    });
  });

  test("permission.gate opens overlay and resolves selection through onAccept", async () => {
    await withGates(async ({ shell, emitter }) => {
      let resolved: unknown;
      emitPermission(emitter, {
        resolve: (outcome: unknown) => {
          resolved = outcome;
        },
      });
      expect(shell.overlayKind).toBe("permissions");
      expect(shell.overlayItems).toEqual(["Reject", "Accept once"]);

      acceptOverlaySelection(shell);
      expect(resolved).toEqual({ allow: false });
    });
  });

  test("permission.gate paints the collapsed body and expands it on toggle", async () => {
    await withGates(
      async ({ shell, emitter }) => {
        emitPermission(emitter, {
          request: baseRequest({
            subject: "echo start && cat > notes.txt <<EOF\nalpha\nbeta\nEOF",
          }),
        });

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
          expect(
            streamRowGutter(row, { width: 80, multiAgent: false }).content,
          ).toBe("");
        }

        expect(toggleOverlayExpand(shell)).toBe(true);
        expect(shell.overlayBodyLines.join("\n")).not.toContain("alpha");
      },
      {
        terminal: { columns: 100, rows: 40 },
        renderer: { width: 100, height: 40 },
      },
    );
  });

  test("operator.gate opens overlay and resolves selection through onAccept", async () => {
    await withGates(async ({ shell, emitter }) => {
      let resolved: unknown;
      emitOperator(emitter, {
        resolve: (result: unknown) => {
          resolved = result;
        },
      });
      expect(shell.overlayKind).toBe("operator");
      expect(shell.overlayItems).toEqual(["Cancel", "Continue"]);

      acceptOverlaySelection(shell);
      expect(resolved).toEqual({ kind: "option", index: 0 });
    });
  });

  test("sequential operator asks paint B's labels and id-scoped values, not A's", async () => {
    await withGates(async ({ shell, emitter }) => {
      let resolvedA: unknown;
      let resolvedB: unknown;
      emitOperator(emitter, {
        id: "ask-a",
        question: "Ask A?",
        options: ["Stay on A", "Leave A"],
        resolve: (result: unknown) => {
          resolvedA = result;
        },
      });
      expect(shell.overlayKind).toBe("operator");
      expect(
        shell.overlayList?.select.options.map((option) => option.name),
      ).toEqual(["Stay on A", "Leave A"]);

      acceptOverlaySelection(shell);
      expect(resolvedA).toEqual({ kind: "option", index: 0 });
      expect(shell.overlayList).toBeNull();

      emitOperator(emitter, {
        id: "ask-b",
        question: "Ask B?",
        options: ["Go with B", "Skip B"],
        resolve: (result: unknown) => {
          resolvedB = result;
        },
      });
      expect(shell.overlayKind).toBe("operator");
      const painted = shell.overlayList?.select.options ?? [];
      expect(painted.map((option) => option.name)).toEqual([
        "Go with B",
        "Skip B",
      ]);
      expect(painted.map((option) => option.value)).toEqual([
        "ask-b:0",
        "ask-b:1",
      ]);
      expect(painted.map((option) => option.value)).not.toContain("ask-a:0");
      expect(painted.map((option) => option.value)).not.toContain("0");

      acceptOverlaySelection(shell);
      expect(resolvedB).toEqual({ kind: "option", index: 0 });
    });
  });

  test("sequential permission.gate asks paint B's labels and id-scoped values, not A's", async () => {
    await withGates(async ({ shell, emitter }) => {
      let resolvedA: unknown;
      let resolvedB: unknown;
      emitPermission(emitter, {
        id: "req-a",
        request: baseRequest({
          subject: "git status",
          scopes: [{ id: "scope-a", label: "Allow git A", pattern: "git A*" }],
        }),
        resolve: (outcome: unknown) => {
          resolvedA = outcome;
        },
      });
      expect(shell.overlayKind).toBe("permissions");
      expect(
        shell.overlayList?.select.options.map((option) => option.name),
      ).toEqual(["Reject", "Accept once", "Allow git A"]);

      closeInsetOverlay(shell);
      expect(resolvedA).toEqual({ allow: false });
      expect(shell.overlayList).toBeNull();

      emitPermission(emitter, {
        id: "req-b",
        request: baseRequest({
          subject: "git push",
          scopes: [{ id: "scope-b", label: "Allow git B", pattern: "git B*" }],
        }),
        resolve: (outcome: unknown) => {
          resolvedB = outcome;
        },
      });
      expect(shell.overlayKind).toBe("permissions");
      const painted = shell.overlayList?.select.options ?? [];
      expect(painted.map((option) => option.name)).toEqual([
        "Reject",
        "Accept once",
        "Allow git B",
      ]);
      expect(painted.map((option) => option.value)).toEqual([
        `req-b:${PERMISSION_DENY_ID}`,
        `req-b:${PERMISSION_ONCE_ID}`,
        "req-b:scope-b",
      ]);
      expect(painted.map((option) => option.value)).not.toContain(
        `req-a:${PERMISSION_DENY_ID}`,
      );
      expect(painted.map((option) => option.value)).not.toContain(
        `req-a:${PERMISSION_ONCE_ID}`,
      );
      expect(painted.map((option) => option.value)).not.toContain(
        "req-a:scope-a",
      );

      acceptOverlaySelection(shell);
      expect(resolvedB).toEqual({ allow: false });
    });
  });

  test("Enter with a painted id missing from the live bag is unavailable", async () => {
    await withGates(async ({ shell, emitter }) => {
      let resolved: unknown;
      emitPermission(emitter, {
        id: "req-b",
        request: baseRequest({ subject: "git push" }),
        resolve: (outcome: unknown) => {
          resolved = outcome;
        },
      });
      expect(shell.overlayKind).toBe("permissions");
      const list = shell.overlayList;
      if (!list) throw new Error("expected an open overlay list");
      list.select.options = [
        {
          name: "Reject",
          description: "",
          value: `req-a:${PERMISSION_DENY_ID}`,
        },
        {
          name: "Accept once",
          description: "",
          value: `req-a:${PERMISSION_ONCE_ID}`,
        },
      ];
      list.select.setSelectedIndex(1);
      acceptOverlaySelection(shell);
      expect(resolved).toEqual(unavailable);
      expect(shell.overlayList).toBeNull();
    });
  });

  test("Enter on an empty permission list is unavailable, not reject", async () => {
    await withGates(async ({ shell, emitter }) => {
      let resolved: unknown;
      emitPermission(emitter, {
        id: "req-b",
        request: baseRequest({ subject: "git push" }),
        resolve: (outcome: unknown) => {
          resolved = outcome;
        },
      });
      expect(shell.overlayKind).toBe("permissions");
      shell.overlayItems = [];
      acceptOverlaySelection(shell);
      expect(resolved).toEqual(unavailable);
      expect(resolved).not.toEqual({ allow: false });
      expect(shell.overlayList).toBeNull();
    });
  });

  test("operator.gate without id cancels without opening", async () => {
    await withGates(async ({ shell, emitter }) => {
      let resolved: unknown;
      emitOperator(emitter, {
        id: undefined,
        resolve: (result: unknown) => {
          resolved = result;
        },
      });
      expect(resolved).toEqual({ kind: "cancel" });
      expect(shell.overlayKind).not.toBe("operator");
    });
  });

  test("permission.gate without id is unavailable without opening", async () => {
    await withGates(async ({ shell, emitter }) => {
      let resolved: unknown;
      emitPermission(emitter, {
        id: undefined,
        resolve: (outcome: unknown) => {
          resolved = outcome;
        },
      });
      expect(resolved).toEqual(unavailable);
      expect(shell.overlayKind).not.toBe("permissions");
    });
  });
});

describe("gate decisions stay out of the transcript", () => {
  test.each([
    {
      name: "permission accept",
      run: (shell: AppShell, emitter: EventEmitter) => {
        emitPermission(emitter);
        acceptOverlaySelection(shell);
      },
    },
    {
      name: "permission Esc/deny",
      run: (shell: AppShell, emitter: EventEmitter) => {
        emitPermission(emitter);
        closeInsetOverlay(shell);
      },
    },
    {
      name: "operator accept",
      run: (shell: AppShell, emitter: EventEmitter) => {
        emitOperator(emitter);
        acceptOverlaySelection(shell);
      },
    },
    {
      name: "operator Esc/cancel",
      run: (shell: AppShell, emitter: EventEmitter) => {
        emitOperator(emitter);
        closeInsetOverlay(shell);
      },
    },
    {
      name: "operator typed answer",
      run: (shell: AppShell, emitter: EventEmitter) => {
        emitOperator(emitter);
        setOverlayAnswerActive(shell, true);
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
      },
    },
    {
      name: "permission auto-deny on timeout",
      run: async (_shell: AppShell, emitter: EventEmitter) => {
        emitPermission(emitter, { timeoutMs: 5 });
        await new Promise((r) => setTimeout(r, 20));
      },
    },
    {
      name: "permission auto-deny on abort",
      run: (_shell: AppShell, emitter: EventEmitter) => {
        const controller = new AbortController();
        emitPermission(emitter, { signal: controller.signal });
        controller.abort();
      },
    },
  ])("$name writes no transcript row", async ({ run }) => {
    await withGates(async ({ shell, emitter }) => {
      const before = shell.streamLog.length;
      await run(shell, emitter);
      expect(shell.streamLog.length - before).toBe(0);
    });
  });

  // The queue's settle-once guard is independent of the transcript: racing a
  // timeout against an abort on the same request exercises that guard.
  // clearTimers must retire the loser before it can run autoDeny a second
  // time, so ev.resolve fires exactly once no matter which trigger wins, and
  // neither path writes a recap row.
  test("a timeout and an abort racing the same request settle once", async () => {
    await withGates(async ({ shell, emitter }) => {
      const controller = new AbortController();
      let resolveCount = 0;
      const before = shell.streamLog.length;
      emitPermission(emitter, {
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
    });
  });

  test("a queued gate's timeout settles once, only after it is displayed", async () => {
    await withGates(async ({ shell, emitter }) => {
      let resolveCount = 0;
      emitPermission(emitter);
      const before = shell.streamLog.length;
      emitPermission(emitter, {
        id: "req-2",
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
    });
  });

  // reconcile() (src/permission/queue.ts) settles a queued request directly
  // when a grant covers it, with no accept/cancel/autoDeny callback of its
  // own. Coverage here is that the queued request still resolves, without
  // ever opening and without writing a recap row.
  test("a grant draining a queued request without ever displaying it", async () => {
    await withGates(async ({ shell, emitter }) => {
      let resolveCount = 0;
      let resolved: unknown;
      // Occupies the overlay host so the second request queues instead of
      // opening — the drain below must resolve it without ever opening it.
      emitPermission(emitter);
      const before = shell.streamLog.length;
      emitPermission(emitter, {
        id: "req-2",
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
    });
  });

  test("a grant draining the currently displayed request closes it without a recap", async () => {
    await withGates(async ({ shell, emitter }) => {
      let resolveCount = 0;
      const before = shell.streamLog.length;
      emitPermission(emitter, {
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
    });
  });

  // drain() (src/permission/queue.ts) denies whatever is still queued on
  // teardown — the same no-call-site path as a grant drain, but the
  // opposite outcome. Coverage is the deny itself; neither path writes a
  // recap row.
  test("disposing with a request still queued denies it without a recap", async () => {
    await withGates(async ({ shell, emitter, disposeGates }) => {
      // The currently-open request has no accept/cancel/autoDeny call site
      // triggered before teardown either, so dispose must settle it too —
      // both entries go through drain() without writing a recap.
      let openResolveCount = 0;
      let queuedResolveCount = 0;
      let queuedResolved: unknown;
      emitPermission(emitter, {
        resolve: () => {
          openResolveCount += 1;
        },
      });
      // Occupies the overlay host so this second request queues instead of
      // opening — dispose must deny it without ever displaying it.
      const before = shell.streamLog.length;
      emitPermission(emitter, {
        id: "req-2",
        request: baseRequest({ tool: "queued_tool" }),
        resolve: (outcome: unknown) => {
          queuedResolveCount += 1;
          queuedResolved = outcome;
        },
      });

      disposeGates();

      expect(openResolveCount).toBe(1);
      expect(queuedResolveCount).toBe(1);
      expect(queuedResolved).toEqual({ allow: false });
      expect(shell.streamLog.length - before).toBe(0);
    });
  });
});

describe("permission.gate auto-deny", () => {
  test("timeoutMs elapsing auto-denies with the timeout message and closes the overlay", async () => {
    await withGates(async ({ shell, emitter }) => {
      let resolved: unknown;
      emitPermission(emitter, {
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
    });
  });

  test("aborting the signal while the overlay is open auto-denies and closes it", async () => {
    await withGates(async ({ shell, emitter }) => {
      const controller = new AbortController();
      let resolved: unknown;
      emitPermission(emitter, {
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
    });
  });

  test("identity abort reason auto-denies and closes the overlay", async () => {
    await withGates(async ({ shell, emitter }) => {
      const controller = new AbortController();
      let resolved: unknown;
      emitPermission(emitter, {
        resolve: (outcome: unknown) => {
          resolved = outcome;
        },
        signal: controller.signal,
      });
      expect(shell.overlayKind).toBe("permissions");

      controller.abort(SESSION_IDENTITY_ABORT_REASON);

      expect(resolved).toEqual({
        allow: false,
        message: SESSION_IDENTITY_ABORT_REASON,
      });
      expect(shell.overlayList).toBeNull();
    });
  });

  test("resolving normally clears the timer instead of firing it later", async () => {
    await withGates(async ({ shell, emitter }) => {
      let resolveCount = 0;
      let lastOutcome: unknown;
      emitPermission(emitter, {
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
    });
  });
});

describe("operator.gate auto-cancel", () => {
  test("timeoutMs elapsing auto-cancels with the timeout label and closes the overlay", async () => {
    await withGates(async ({ shell, emitter }) => {
      let resolved: unknown;
      emitOperator(emitter, {
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
    });
  });

  test("aborting the signal while the overlay is open auto-cancels and closes it", async () => {
    await withGates(async ({ shell, emitter }) => {
      const controller = new AbortController();
      let resolved: unknown;
      emitOperator(emitter, {
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
    });
  });

  // The queue-behind hazard from CL-5664: a stuck overlay in front of an
  // ask_operator question must not hang the run forever with nothing on
  // screen to answer. The abort listener is not display-dependent, so it
  // must settle the queued gate even though it never opened.
  test("aborting the run while the operator gate is still queued settles it without ever opening", async () => {
    await withGates(async ({ shell, emitter }) => {
      const controller = new AbortController();
      let resolved: unknown;
      emitPermission(emitter);
      emitOperator(emitter, {
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
    });
  });

  test("a queued operator gate's timeout does not start until it is displayed", async () => {
    await withGates(async ({ shell, emitter }) => {
      let firstResolved: unknown;
      let secondResolved: unknown;
      emitPermission(emitter, {
        resolve: (outcome: unknown) => {
          firstResolved = outcome;
        },
      });
      emitOperator(emitter, {
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
    });
  });

  test("resolving normally clears the timer instead of firing it later", async () => {
    await withGates(async ({ shell, emitter }) => {
      let resolveCount = 0;
      emitOperator(emitter, {
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
    });
  });

  // Mirrors the permission queue's "disposing with a request still queued"
  // coverage: unlike permissionQueue, the operator gate has no queue module
  // of its own, so wireGates must track outstanding operator gates itself to
  // settle them on teardown.
  test("disposing with a gate still queued settles it instead of hanging", async () => {
    await withGates(async ({ shell, emitter, disposeGates }) => {
      let openResolved: unknown;
      let queuedResolved: unknown;
      emitOperator(emitter, {
        id: "ask-open",
        options: ["Yes", "No"],
        resolve: (r: unknown) => {
          openResolved = r;
        },
      });
      // Occupies the overlay host so this second gate queues instead of
      // opening — dispose must cancel it without ever displaying it.
      const before = shell.streamLog.length;
      emitOperator(emitter, {
        id: "ask-queued",
        question: "Also proceed?",
        options: ["Yes", "No"],
        resolve: (r: unknown) => {
          queuedResolved = r;
        },
      });

      disposeGates();

      expect(openResolved).toEqual(operatorCancelResult());
      expect(queuedResolved).toEqual(operatorCancelResult());
      expect(shell.streamLog.length - before).toBe(0);
    });
  });
});

describe("Esc on a gate overlay settles the awaited promise", () => {
  test("permission.gate: Esc denies instead of abandoning the promise", async () => {
    await withGates(async ({ shell, emitter }) => {
      let resolved: unknown;
      let resolveCount = 0;
      emitPermission(emitter, {
        resolve: (outcome: unknown) => {
          resolveCount += 1;
          resolved = outcome;
        },
      });

      closeInsetOverlay(shell);

      expect(resolveCount).toBe(1);
      expect(resolved).toEqual({ allow: false });
      expect(resolved).not.toEqual(unavailable);
    });
  });

  test("operator.gate: Esc cancels instead of abandoning the promise", async () => {
    await withGates(async ({ shell, emitter }) => {
      let resolved: unknown;
      let resolveCount = 0;
      emitOperator(emitter, {
        resolve: (result: unknown) => {
          resolveCount += 1;
          resolved = result;
        },
      });

      closeInsetOverlay(shell);

      expect(resolveCount).toBe(1);
      expect(resolved).toEqual({ kind: "cancel" });
    });
  });
});

describe("permission overlay height", () => {
  const openGate = (emitter: EventEmitter, scopeCount: number): void => {
    emitPermission(emitter, {
      request: baseRequest({
        subject: "ls -la ~/.corbits/projects 2>/dev/null | head -40",
        scopes: Array.from({ length: scopeCount }, (_, i) => ({
          id: `s${i}`,
          label: `Always allow scope ${i}`,
          pattern: `p${i}`,
        })),
      }),
    });
  };

  const hostRowsFor = async (
    rows: number,
    scopeCount: number,
  ): Promise<number> => {
    let height = -1;
    await withGates(
      async ({ shell, emitter }) => {
        openGate(emitter, scopeCount);
        height = shell.layout.heights.overlay_host;
      },
      {
        terminal: { columns: 96, rows },
        renderer: { width: 96, height: rows },
      },
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
  const askOperator = (
    emitter: EventEmitter,
    options: readonly string[],
    onResolve: (result: unknown) => void,
  ): void => {
    emitOperator(emitter, {
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
    body: (
      h: Harness,
      shell: AppShell,
      resolved: () => unknown,
    ) => void | Promise<void>,
  ): Promise<void> => {
    await withGates(
      async ({ h, shell, emitter }) => {
        let resolved: unknown = undefined;
        askOperator(emitter, options, (r) => {
          resolved = r;
        });
        await body(h, shell, () => resolved);
      },
      {
        terminal: { columns: 96, rows },
        renderer: { width: 96, height: rows },
      },
    );
  };

  const frameOf = async (h: Harness): Promise<string> => {
    await h.renderOnce();
    await h.renderOnce();
    return h.captureCharFrame();
  };

  for (const rows of [24, 60]) {
    test(`several options render and resolve by index at ${rows} rows`, async () => {
      await withOperator(
        rows,
        ["repo only", "docs too", "everything"],
        (h, shell, resolved) => {
          expect(shell.overlayKind).toBe("operator");
          expect(shell.overlayItems).toEqual([
            "repo only",
            "docs too",
            "everything",
          ]);
          moveOverlaySelection(shell, 1);
          acceptOverlaySelection(shell);
          expect(resolved()).toEqual({ kind: "option", index: 1 });
          void h;
        },
      );
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

  test("a typed answer round-trips as a custom OperatorResult", async () => {
    await withOperator(
      40,
      ["repo only", "everything"],
      (h, shell, resolved) => {
        expect(setOverlayAnswerActive(shell, true)).toBe(true);
        for (const ch of "src and docs") {
          expect(handleOverlayAnswerKey(shell, keyOf(ch))).toBe(true);
        }
        expect(handleOverlayAnswerKey(shell, keyOf("x", "backspace"))).toBe(
          true,
        );
        expect(handleOverlayAnswerKey(shell, keyOf("", "return"))).toBe(true);
        expect(resolved()).toEqual({ kind: "custom", text: "src and doc" });
        // Submitting closes the overlay, so the host is free for the next gate.
        expect(shell.overlayList).toBeNull();
        void h;
      },
    );
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
    await withGates(
      async ({ shell, emitter }) => {
        let approved: unknown = undefined;
        let answered: unknown = undefined;
        emitPermission(emitter, {
          resolve: (o: unknown) => {
            approved = o;
          },
        });
        emitOperator(emitter, {
          id: "ask-queued",
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
      },
      {
        terminal: { columns: 96, rows: 40 },
        renderer: { width: 96, height: 40 },
      },
    );
  });
});
