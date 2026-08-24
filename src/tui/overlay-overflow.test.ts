/**
 * CL-5694: approval/operator overlay overflow conformance.
 *
 * On a short terminal the decision overlay must cap its host, shrink the
 * list-viewport, and keep every choice reachable by navigation — not spill
 * past the frame or trap the cursor on the first visible rows.
 */
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "../permission/types.js";
import { withTestRenderer } from "./harness.js";
import { OVERLAY_MAX_FRACTION } from "./geometry/index.js";
import {
  acceptOverlaySelection,
  appendStreamRow,
  createAppShell,
  moveOverlaySelection,
  type AppShell,
} from "./shell.js";
import { visibleSlice } from "./list-viewport.js";
import { makePermissionItems, openOperatorOverlay, openPermissionsOverlay } from "./overlays.js";
import {
  operatorChoicesFromOptions,
  permissionBodyFromRequest,
  permissionChoicesFromRequest,
  wireGates,
} from "./gate-wire.js";

const SHORT = { width: 80, height: 10 } as const;
const COMFORTABLE = { width: 80, height: 24 } as const;

const tallBody = [
  "The agent wants to run a destructive command on the working tree.",
  "Review the plan carefully — this cannot be undone from the TUI.",
  "",
  "Proposed: git reset --hard origin/main && rm -rf node_modules",
  "Files at risk: 128 modified, 12 untracked.",
  "Continue only if you accept discarding local work.",
  "Also note: this path was requested by the explore agent.",
  "Scopes include session, project, and once-only grants.",
].join("\n");

const manyChoices = Array.from({ length: 16 }, (_, i) => `Choice ${String(i).padStart(2, "0")}`);

function primeSession(shell: AppShell): void {
  // Non-landing layout: the host sits in-flow and competes with the prompt
  // for rows the same way a live approval does mid-session.
  appendStreamRow(shell, { role: "assistant", text: "session underway" });
}

function activeVisible(shell: AppShell): void {
  const list = shell.overlayList;
  expect(list).not.toBeNull();
  if (!list) return;
  const slice = visibleSlice(list);
  expect(list.activeIndex).toBeGreaterThanOrEqual(slice.start);
  expect(list.activeIndex).toBeLessThan(slice.end);
}

async function frameLineCount(
  open: (shell: AppShell) => void,
  size: { readonly width: number; readonly height: number },
): Promise<number> {
  return withTestRenderer(async (h) => {
    const shell = createAppShell(h.renderer, {
      terminal: { columns: size.width, rows: size.height },
      run: "idle",
    });
    try {
      primeSession(shell);
      open(shell);
      await h.renderOnce();
      await h.renderOnce();
      const frame = h.captureCharFrame();
      return frame.replace(/\n$/, "").split("\n").length;
    } finally {
      shell.dispose();
    }
  }, size);
}

describe("approval overlay overflow (short terminal)", () => {
  test("many permission choices shrink the viewport and scroll under navigation", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: SHORT.width, rows: SHORT.height },
        run: "idle",
      });
      try {
        primeSession(shell);
        const items = makePermissionItems(20);
        openPermissionsOverlay(shell, {
          items,
          body: tallBody,
        });
        expect(shell.overlayKind).toBe("permissions");
        expect(shell.overlayList).not.toBeNull();
        const list = shell.overlayList!;
        // Host is fraction-capped: the window holds fewer items than exist.
        expect(list.height).toBeLessThan(items.length);
        expect(list.height).toBeGreaterThanOrEqual(1);
        expect(list.offset).toBe(0);
        expect(shell.layout.heights.overlay_host).toBeLessThanOrEqual(
          Math.floor(SHORT.height * OVERLAY_MAX_FRACTION),
        );

        const startOffset = list.offset;
        // Walk past the window so keep-active-visible must advance offset.
        for (let i = 0; i < list.height + 3; i++) {
          moveOverlaySelection(shell, 1);
        }
        expect(shell.overlayList!.activeIndex).toBe(list.height + 3);
        expect(shell.overlayList!.offset).toBeGreaterThan(startOffset);
        activeVisible(shell);

        // Last choice is still reachable and accept closes the overlay.
        const last = items.length - 1;
        while (shell.overlayList!.activeIndex < last) {
          moveOverlaySelection(shell, 1);
        }
        expect(shell.overlayList!.activeIndex).toBe(last);
        activeVisible(shell);
        acceptOverlaySelection(shell);
        expect(shell.overlayList).toBeNull();
      } finally {
        shell.dispose();
      }
    }, SHORT);
  });

  test("short permission list stays selectable when the viewport is one row", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: SHORT.width, rows: SHORT.height },
        run: "idle",
      });
      try {
        primeSession(shell);
        const items = ["Reject", "Accept once"] as const;
        openPermissionsOverlay(shell, {
          items,
          body: "run_shell\nRun shell command\nbun test",
        });
        const list = shell.overlayList!;
        expect(list.count).toBe(2);
        // On a short terminal the host fraction can leave only one list row.
        // Both choices must still be reachable and accept must close.
        expect(list.height).toBeGreaterThanOrEqual(1);
        expect(list.offset).toBe(0);
        moveOverlaySelection(shell, 1);
        expect(shell.overlayList!.activeIndex).toBe(1);
        activeVisible(shell);
        acceptOverlaySelection(shell);
        expect(shell.overlayList).toBeNull();
      } finally {
        shell.dispose();
      }
    }, SHORT);
  });

  test("operator overlay with many choices scrolls; every choice is reachable", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: SHORT.width, rows: SHORT.height },
        run: "idle",
      });
      try {
        primeSession(shell);
        openOperatorOverlay(shell, {
          body: tallBody,
          choices: manyChoices,
        });
        expect(shell.overlayKind).toBe("operator");
        const list = shell.overlayList!;
        expect(list.height).toBeLessThan(manyChoices.length);
        expect(list.offset).toBe(0);

        for (let i = 0; i < manyChoices.length - 1; i++) {
          moveOverlaySelection(shell, 1);
          activeVisible(shell);
        }
        expect(shell.overlayList!.activeIndex).toBe(manyChoices.length - 1);
        expect(shell.overlayList!.offset).toBeGreaterThan(0);
        // Keep active in the viewport window (offset/height contract), not a
        // frame substring — on short terminals the tall body can own the host
        // paint while the list still scrolls in state.
        activeVisible(shell);
        acceptOverlaySelection(shell);
        expect(shell.overlayList).toBeNull();

        await h.renderOnce();
        const frame = h.captureCharFrame();
        expect(frame.replace(/\n$/, "").split("\n").length).toBeLessThanOrEqual(SHORT.height);
      } finally {
        shell.dispose();
      }
    }, SHORT);
  });

  test("painted frame never exceeds the short terminal height", async () => {
    const lines = await frameLineCount(
      (shell) =>
        openPermissionsOverlay(shell, {
          items: makePermissionItems(20),
          body: tallBody,
        }),
      SHORT,
    );
    expect(lines).toBeLessThanOrEqual(SHORT.height);
  });

  test("comfortable terminal still scrolls a longer list past the host cap", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: COMFORTABLE.width, rows: COMFORTABLE.height },
        run: "idle",
      });
      try {
        primeSession(shell);
        const items = makePermissionItems(40);
        openPermissionsOverlay(shell, { items, body: tallBody });
        const list = shell.overlayList!;
        // Even at 24 rows the fraction cap can force a window smaller than 40.
        if (list.height < items.length) {
          const start = list.offset;
          for (let i = 0; i < list.height + 2; i++) {
            moveOverlaySelection(shell, 1);
          }
          expect(shell.overlayList!.offset).toBeGreaterThan(start);
          activeVisible(shell);
        } else {
          // Cap did not bind; every item is already visible without scroll.
          expect(list.offset).toBe(0);
          expect(list.height).toBeGreaterThanOrEqual(items.length);
        }
      } finally {
        shell.dispose();
      }
    }, COMFORTABLE);
  });
});

describe("gate-wire approval overflow on short terminal", () => {
  test("permission.gate with many scopes scrolls and resolves the last choice", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: SHORT.width, rows: SHORT.height },
        run: "idle",
      });
      const emitter = new EventEmitter();
      let resolved: unknown;
      const request: PermissionRequest = {
        tool: "run_shell",
        action: "Run shell command",
        subject: "ls -la ~/.corbits/projects 2>/dev/null | head -40",
        scopes: Array.from({ length: 12 }, (_, i) => ({
          id: `s${i}`,
          label: `Always allow scope ${i}`,
          pattern: `p${i}`,
        })),
      };
      try {
        primeSession(shell);
        const dispose = wireGates(emitter, shell);
        emitter.emit("permission.gate", {
          request,
          resolve: (outcome: unknown) => {
            resolved = outcome;
          },
        });

        const choices = permissionChoicesFromRequest(request);
        expect(shell.overlayKind).toBe("permissions");
        expect(shell.overlayItems).toEqual([...choices.items]);
        const list = shell.overlayList!;
        expect(list.height).toBeLessThan(choices.items.length);

        const last = choices.items.length - 1;
        while (shell.overlayList!.activeIndex < last) {
          moveOverlaySelection(shell, 1);
        }
        activeVisible(shell);
        acceptOverlaySelection(shell);
        expect(resolved).toEqual(
          expect.objectContaining({ allow: true, persist: expect.objectContaining({ id: "s11" }) }),
        );
        expect(shell.overlayList).toBeNull();
        dispose();
      } finally {
        shell.dispose();
      }
    }, SHORT);
  });

  test("operator.gate with many options scrolls and resolves by index", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: SHORT.width, rows: SHORT.height },
        run: "idle",
      });
      const emitter = new EventEmitter();
      let resolved: unknown;
      const options = manyChoices;
      try {
        primeSession(shell);
        const dispose = wireGates(emitter, shell);
        emitter.emit("operator.gate", {
          question: tallBody,
          options: [...options],
          resolve: (result: unknown) => {
            resolved = result;
          },
        });

        const choices = operatorChoicesFromOptions(options);
        expect(shell.overlayKind).toBe("operator");
        expect(shell.overlayItems).toEqual([...choices.items]);
        const list = shell.overlayList!;
        expect(list.height).toBeLessThan(options.length);

        const target = options.length - 1;
        while (shell.overlayList!.activeIndex < target) {
          moveOverlaySelection(shell, 1);
        }
        activeVisible(shell);
        acceptOverlaySelection(shell);
        expect(resolved).toEqual({ kind: "option", index: target });
        dispose();
      } finally {
        shell.dispose();
      }
    }, SHORT);
  });

  test("permission body from a bulk request still opens under the height cap", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: SHORT.width, rows: SHORT.height },
        run: "idle",
      });
      const emitter = new EventEmitter();
      const request: PermissionRequest = {
        tool: "run_shell",
        action: "Run shell command",
        subject: 'git commit -m "line one\nline two\nline three\nline four\nline five"',
        scopes: [{ id: "session", label: "Allow for session", pattern: "git *" }],
      };
      try {
        primeSession(shell);
        const dispose = wireGates(emitter, shell);
        emitter.emit("permission.gate", { request, resolve: () => {} });

        const body = permissionBodyFromRequest(request, { hint: true });
        // The raw body still carries the collapsed-command hint — only what
        // gets painted is squeezed. On this short a terminal (CL-5750) the
        // choices win the row budget over the hint text, so the rendered
        // lines are not required to contain it.
        expect(body).toContain("e expand");
        expect(shell.layout.heights.overlay_host).toBeLessThanOrEqual(
          Math.floor(SHORT.height * OVERLAY_MAX_FRACTION),
        );
        // Two base choices + one scope still navigable.
        expect(shell.overlayItems.length).toBe(3);
        moveOverlaySelection(shell, 2);
        activeVisible(shell);
        dispose();
      } finally {
        shell.dispose();
      }
    }, SHORT);
  });
});
