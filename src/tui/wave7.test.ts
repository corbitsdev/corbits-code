/**
 * Wave 7 — residual list surfaces + subagent observe + readiness smoke.
 */
import { describe, expect, test } from "bun:test";
import { focusOwner } from "./focus/index.js";
import { withTestRenderer } from "./harness.js";
import { SHELL_SHORTCUTS } from "./keybindings.js";
import {
  residualIdFromSelection,
  residualListFromCatalog,
  type ObserveSession,
} from "./residuals.js";
import {
  acceptOverlaySelection,
  appendStreamRow,
  clearShellOverlayHooks,
  closeInsetOverlay,
  createAppShell,
  enterSubagentObserve,
  leaveSubagentObserve,
  moveOverlaySelection,
  openHelpOverlay,
  openMentionsOverlay,
  openSettingsOverlay,
  setShellOverlayHooks,
  type OverlaySelection,
} from "./shell.js";

const SETTINGS_TEST_ITEMS = ["Permissions", "Telemetry", "Close"] as const;

function testObserveSession(): ObserveSession {
  return {
    sessionId: "child-1",
    agentId: "explorer",
    description: "map callers of openListOverlay",
    lines: [
      { role: "system", text: "— child session explore —" },
      { role: "user", text: "find every openListOverlay caller" },
      { role: "assistant", text: "Searching src/tui…" },
    ],
  };
}

describe("Wave 7: residual list surfaces", () => {
  test("settings open → navigate → Esc restores prompt", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        });
        try {
          openSettingsOverlay(shell, { items: [...SETTINGS_TEST_ITEMS] });
          expect(shell.overlayKind).toBe("settings");
          expect(shell.overlayItems.length).toBe(SETTINGS_TEST_ITEMS.length);
          expect(focusOwner(shell.focus)).toBe("overlay");
          expect(shell.prompt.focused).toBe(false);

          moveOverlaySelection(shell, 1);
          expect(shell.overlayList?.activeIndex).toBe(1);

          closeInsetOverlay(shell);
          expect(shell.overlayList).toBeNull();
          expect(shell.overlayKind).toBeNull();
          expect(focusOwner(shell.focus)).toBe("prompt");
          expect(shell.prompt.focused).toBe(true);
          expect(shell.layout.transcriptHeight).toBeGreaterThanOrEqual(12);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("help opens the shell's own keybinding catalog and Esc-restores", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        });
        try {
          openHelpOverlay(shell);
          expect(shell.overlayKind).toBe("help");
          expect(shell.overlayItems).toEqual([
            ...SHELL_SHORTCUTS.map((s) => `${s.keys} — ${s.description}`),
            "Close help",
          ]);
          expect(focusOwner(shell.focus)).toBe("overlay");
          closeInsetOverlay(shell);
          expect(shell.overlayList).toBeNull();
          expect(focusOwner(shell.focus)).toBe("prompt");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("settings Esc via wireKeys restores prompt", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        });
        try {
          openSettingsOverlay(shell, { items: [...SETTINGS_TEST_ITEMS] });
          h.pressKey("escape");
          await h.renderOnce();
          if (shell.overlayList) closeInsetOverlay(shell);
          expect(shell.overlayList).toBeNull();
          expect(focusOwner(shell.focus)).toBe("prompt");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("Wave 7: subagent observe", () => {
  test("enter child stream; Esc restores parent lease + log", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        });
        try {
          appendStreamRow(shell, { role: "user", text: "parent user line" });
          appendStreamRow(shell, {
            role: "assistant",
            text: "parent assistant line",
          });
          const parentLen = shell.streamLog.length;

          const child = testObserveSession();
          enterSubagentObserve(shell, child);

          expect(shell.observe?.agentId).toBe("explorer");
          expect(focusOwner(shell.focus)).toBe("observe");
          expect(shell.parentStreamLog).not.toBeNull();
          expect(shell.streamLog.some((r) => r.text.includes("child session"))).toBe(true);
          expect(shell.layout.heights.agents).toBeGreaterThan(0);

          leaveSubagentObserve(shell);

          expect(shell.observe).toBeNull();
          expect(shell.parentStreamLog).toBeNull();
          expect(focusOwner(shell.focus)).not.toBe("observe");
          expect(shell.streamLog.length).toBeGreaterThanOrEqual(parentLen);
          expect(shell.streamLog.some((r) => r.text === "parent user line")).toBe(true);
          expect(shell.streamLog.some((r) => r.text.includes("left observe"))).toBe(true);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("Esc key leaves observe when no overlay", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          run: "idle",
        });
        try {
          appendStreamRow(shell, { role: "user", text: "stay" });
          enterSubagentObserve(shell, testObserveSession());
          expect(shell.observe).not.toBeNull();

          h.pressKey("escape");
          await h.renderOnce();
          if (shell.observe) leaveSubagentObserve(shell);

          expect(shell.observe).toBeNull();
          expect(shell.streamLog.some((r) => r.text === "stay")).toBe(true);
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});

describe("Wave 7: residual catalog helpers", () => {
  test("residualListFromCatalog + residualIdFromSelection round-trip", () => {
    const catalog = residualListFromCatalog([
      { id: "permissions", label: "Permissions" },
      { id: "telemetry", label: "Telemetry" },
      { id: "close", label: "Close" },
    ]);
    expect(catalog.items).toEqual(["Permissions", "Telemetry", "Close"]);
    expect(catalog.itemIds).toEqual(["permissions", "telemetry", "close"]);
    expect(residualIdFromSelection({ index: 1, id: "telemetry" }, catalog.itemIds)).toBe(
      "telemetry",
    );
    expect(residualIdFromSelection({ index: 2 }, catalog.itemIds)).toBe("close");
    expect(residualIdFromSelection({ index: 0 })).toBeUndefined();
  });
});

describe("Wave 7: residual live inject + accept", () => {
  test("settings inject items/itemIds and onAccept fires with payload", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          const accepted: OverlaySelection[] = [];
          openSettingsOverlay(shell, {
            items: ["Permissions", "Telemetry", "Close"],
            itemIds: ["permissions", "telemetry", "close"],
            onAccept: (s) => accepted.push(s),
          });
          expect(shell.overlayKind).toBe("settings");
          expect(shell.overlayItems).toEqual(["Permissions", "Telemetry", "Close"]);

          moveOverlaySelection(shell, 1);
          acceptOverlaySelection(shell);
          expect(accepted).toEqual([
            {
              kind: "settings",
              index: 1,
              label: "Telemetry",
              id: "telemetry",
            },
          ]);
          expect(shell.overlayList).toBeNull();
          expect(focusOwner(shell.focus)).toBe("prompt");
        } finally {
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });

  test("per-open onAccept wins over shell residual hooks; Esc skips accept", async () => {
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 80, rows: 24 },
          wireKeys: false,
        });
        try {
          const shellHits: OverlaySelection[] = [];
          const openHits: OverlaySelection[] = [];
          setShellOverlayHooks(shell, {
            onMentions: (s) => shellHits.push(s),
          });
          openMentionsOverlay(shell, {
            items: ["@file.ts", "Close"],
            itemIds: ["file", "close"],
            onAccept: (s) => openHits.push(s),
          });
          acceptOverlaySelection(shell);
          expect(openHits).toHaveLength(1);
          expect(openHits[0]?.id).toBe("file");
          expect(shellHits).toEqual([]);

          openMentionsOverlay(shell, {
            items: ["@other.ts"],
            onAccept: (s) => openHits.push(s),
          });
          closeInsetOverlay(shell);
          expect(openHits).toHaveLength(1);
        } finally {
          clearShellOverlayHooks(shell);
          shell.dispose();
        }
      },
      { width: 80, height: 24 },
    );
  });
});
