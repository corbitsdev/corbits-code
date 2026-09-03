/**
 * CL-6699: a queued permission/operator gate must not open onto the host in
 * the middle of a `/` command filter session. The old close-then-reopen
 * refresh (closeSlashPopup -> closeInsetOverlay -> notifyOverlayClosed)
 * released the host between the two calls, and a gate queued behind the
 * popup drained into that gap.
 *
 * CL-6711: accepting a slash/palette command must not drain that same queue
 * onto the host before dispatch has claimed it. A live gate already on the
 * host is not stolen; the command surface waits until that gate settles.
 */
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";

import { withTestRenderer } from "./harness";
import type { PaletteCommand } from "./command-catalog";
import {
  openCommandSurface,
  type CommandSurfaceDeps,
  type PluginsSurfaceDeps,
} from "./command-surfaces";
import { wireGates } from "./gate-wire";
import { openPermissionsOverlay } from "./overlays";
import {
  acceptOverlaySelection,
  closeInsetOverlay,
  closeReplaceableOverlay,
  createAppShell,
  cycleOverlaySelection,
  isSlashPopupOpen,
  moveOverlaySelection,
  onOverlayClosed,
  openHelpOverlay,
  openListOverlay,
  openPalette,
  type AppShell,
} from "./shell";

const CATALOG: readonly PaletteCommand[] = [
  {
    id: "help",
    label: "/help",
    description: "Open keymap",
    keywords: ["help", "Open keymap", "slash", "command"],
  },
  {
    id: "model",
    label: "/model",
    description: "Open model picker",
    keywords: ["model", "Open model picker", "slash", "command"],
  },
  { id: "mcp", label: "/mcp" },
  { id: "compact", label: "/compact" },
  { id: "settings", label: "/settings" },
];

interface Ctx {
  readonly shell: AppShell;
  readonly press: (key: string) => void;
  readonly render: () => Promise<void>;
}

function withShell(
  fn: (ctx: Ctx) => Promise<void>,
  opts?: {
    readonly onCommand?: (name: string, shell: AppShell) => void;
  },
): Promise<void> {
  return withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: true,
        run: "idle",
        paletteCatalog: CATALOG,
        onCommand: (name) => {
          if (opts?.onCommand) {
            opts.onCommand(name, shell);
            return;
          }
          if (name === "help") openHelpOverlay(shell);
        },
      });
      try {
        await fn({
          shell,
          press: (key) => h.pressKey(key as Parameters<typeof h.pressKey>[0]),
          render: h.renderOnce,
        });
      } finally {
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
}

function emitPermissionGate(
  emitter: EventEmitter,
  resolve: (outcome: unknown) => void,
  extra?: { readonly timeoutMs?: number; readonly tool?: string },
): void {
  emitter.emit("permission.gate", {
    request: {
      tool: extra?.tool ?? "run_shell",
      action: "Run shell command",
      subject: "bun test",
      scopes: [],
    },
    resolve,
    ...(extra?.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
  });
}

function typePrompt(press: (key: string) => void, text: string): void {
  for (const ch of text) press(ch);
}

function hangingSettingsList(): {
  readonly list: Promise<readonly []>;
  readonly resolve: () => void;
} {
  let resolveList: (entries: readonly []) => void = () => undefined;
  const list = new Promise<readonly []>((resolve) => {
    resolveList = resolve;
  });
  return {
    list,
    resolve: () => resolveList([]),
  };
}

function settingsOnCommand(list: Promise<readonly []>): (name: string, shell: AppShell) => void {
  return (name, shell) => {
    if (name !== "settings") return;
    openCommandSurface(shell, "settings", {
      notify: () => undefined,
      settings: {
        read: () => ({
          compactionMode: "llm",
          waitForApproval: true,
          telemetryEnabled: false,
          showPromptCost: false,
        }),
        setCompactionMode: () => undefined,
        setWaitForApproval: () => undefined,
        setTelemetryEnabled: () => undefined,
        setShowPromptCost: () => undefined,
      },
      permissions: {
        list: () => list,
        revoke: () => Promise.resolve(),
      },
    });
  };
}

describe("/ popup keeps a queued gate queued across a filter refresh", () => {
  test("filter keystroke while a gate is queued", async () => {
    await withShell(async ({ shell, press }) => {
      const emitter = new EventEmitter();
      const dispose = wireGates(emitter, shell);
      // The host closing (onOverlayClosed) is what the queued gate waits
      // on to drain — see gate-wire.ts's onOverlayClosed/pending. Under the
      // old close-then-reopen refresh this fires on every filter keystroke
      // (closeSlashPopup -> closeInsetOverlay -> notifyOverlayClosed) even
      // though the palette immediately re-stacks on top and every assertion
      // on shell.overlayKind alone sees only "palette" again by the time it
      // runs. Counting this call directly is what actually distinguishes
      // the in-place refresh from the old close+reopen one.
      let closedCount = 0;
      const disposeClosedSpy = onOverlayClosed(shell, () => {
        closedCount++;
      });
      try {
        press("/");
        expect(isSlashPopupOpen(shell)).toBe(true);
        expect(shell.overlayKind).toBe("palette");

        let resolved: unknown;
        emitPermissionGate(emitter, (outcome) => {
          resolved = outcome;
        });

        // Queued, not opened — the slash popup still owns the host.
        expect(shell.overlayKind).toBe("palette");
        expect(resolved).toBeUndefined();
        expect(closedCount).toBe(0);

        // Refreshing the filter must not release the host to the queued gate.
        press("m");
        expect(shell.prompt.value).toBe("/m");
        expect(shell.overlayKind).toBe("palette");
        expect(isSlashPopupOpen(shell)).toBe(true);
        expect(shell.paletteCommands.map((c) => c.id)).toEqual(["model", "mcp"]);
        expect(resolved).toBeUndefined();
        expect(closedCount).toBe(0);

        // Filtering keeps working after the refresh.
        press("o");
        expect(shell.prompt.value).toBe("/mo");
        expect(shell.paletteCommands.map((c) => c.id)).toEqual(["model"]);
        expect(isSlashPopupOpen(shell)).toBe(true);
        expect(resolved).toBeUndefined();
        expect(closedCount).toBe(0);

        // A keystroke that drops matches to zero must not dismiss the popup
        // either — it stays owned with a "(no matches)" row, and the gate
        // stays queued behind it.
        press("z");
        expect(shell.prompt.value).toBe("/moz");
        expect(isSlashPopupOpen(shell)).toBe(true);
        expect(shell.overlayKind).toBe("palette");
        expect(shell.paletteCommands).toEqual([]);
        expect(shell.overlayItems).toEqual(["(no matches)"]);
        expect(resolved).toBeUndefined();
        expect(closedCount).toBe(0);

        // A backspace that restores matches refreshes back in place too.
        press("Backspace");
        expect(shell.prompt.value).toBe("/mo");
        expect(shell.paletteCommands.map((c) => c.id)).toEqual(["model"]);
        expect(isSlashPopupOpen(shell)).toBe(true);
        expect(resolved).toBeUndefined();
        expect(closedCount).toBe(0);

        // A true dismiss still drains the queue as before.
        press("Escape");
        await Bun.sleep(60);
        expect(shell.overlayKind).toBe("permissions");
        expect(resolved).toBeUndefined();
        expect(closedCount).toBe(1);
      } finally {
        disposeClosedSpy();
        dispose();
      }
    });
  });

  test("Enter on zero matches closes the popup, keeps the typed text, and drains a queued gate", async () => {
    await withShell(async ({ shell, press }) => {
      const emitter = new EventEmitter();
      const dispose = wireGates(emitter, shell);
      const disposeClosedSpy = onOverlayClosed(shell, () => {});
      try {
        press("/");
        press("m");
        press("o");
        press("z");
        expect(shell.prompt.value).toBe("/moz");
        expect(shell.paletteCommands).toEqual([]);
        expect(isSlashPopupOpen(shell)).toBe(true);

        let resolved: unknown;
        emitPermissionGate(emitter, (outcome) => {
          resolved = outcome;
        });
        expect(shell.overlayKind).toBe("palette");
        expect(resolved).toBeUndefined();

        // Enter with no active command must not wipe the typed text.
        press("Enter");
        expect(isSlashPopupOpen(shell)).toBe(false);
        expect(shell.prompt.value).toBe("/moz");

        // Popup close is a genuine dismiss: the queued gate drains onto it.
        await Bun.sleep(60);
        expect(shell.overlayKind).toBe("permissions");
        expect(resolved).toBeUndefined();
      } finally {
        disposeClosedSpy();
        dispose();
      }
    });
  });

  test("Tab name-complete still drains a queued gate", async () => {
    await withShell(async ({ shell, press }) => {
      const emitter = new EventEmitter();
      const dispose = wireGates(emitter, shell);
      try {
        press("/");
        expect(isSlashPopupOpen(shell)).toBe(true);

        let resolved: unknown;
        emitPermissionGate(emitter, (outcome) => {
          resolved = outcome;
        });
        expect(shell.overlayKind).toBe("palette");
        expect(resolved).toBeUndefined();

        press("Tab");
        expect(isSlashPopupOpen(shell)).toBe(false);
        expect(shell.prompt.value).toBe("/help ");

        await Bun.sleep(60);
        expect(shell.overlayKind).toBe("permissions");
        expect(resolved).toBeUndefined();
      } finally {
        dispose();
      }
    });
  });
});

describe("slash/palette accept holds the host until dispatch settles", () => {
  test("Enter on /help while a gate is queued opens help, then drains the gate", async () => {
    await withShell(async ({ shell, press }) => {
      const emitter = new EventEmitter();
      const dispose = wireGates(emitter, shell);
      try {
        typePrompt(press, "/help");
        expect(isSlashPopupOpen(shell)).toBe(true);
        expect(shell.paletteCommands.map((c) => c.id)).toEqual(["help"]);

        let resolved: unknown;
        emitPermissionGate(emitter, (outcome) => {
          resolved = outcome;
        });
        expect(shell.overlayKind).toBe("palette");
        expect(resolved).toBeUndefined();

        press("Enter");
        expect(isSlashPopupOpen(shell)).toBe(false);
        expect(shell.overlayKind).toBe("help");
        expect(resolved).toBeUndefined();

        closeInsetOverlay(shell);
        await Bun.sleep(60);
        expect(shell.overlayKind).toBe("permissions");
        expect(resolved).toBeUndefined();
      } finally {
        dispose();
      }
    });
  });

  test("Enter on a no-surface command while a gate is queued still drains", async () => {
    await withShell(async ({ shell, press }) => {
      const emitter = new EventEmitter();
      const dispose = wireGates(emitter, shell);
      try {
        typePrompt(press, "/compact");
        expect(isSlashPopupOpen(shell)).toBe(true);
        expect(shell.paletteCommands.map((c) => c.id)).toEqual(["compact"]);

        let resolved: unknown;
        emitPermissionGate(emitter, (outcome) => {
          resolved = outcome;
        });
        expect(shell.overlayKind).toBe("palette");

        press("Enter");
        expect(isSlashPopupOpen(shell)).toBe(false);
        await Bun.sleep(60);
        expect(shell.overlayKind).toBe("permissions");
        expect(resolved).toBeUndefined();
      } finally {
        dispose();
      }
    });
  });

  test("palette stacked over a live gate defers /help until the gate closes", async () => {
    await withShell(async ({ shell }) => {
      const emitter = new EventEmitter();
      const dispose = wireGates(emitter, shell);
      try {
        let resolved: unknown;
        emitPermissionGate(emitter, (outcome) => {
          resolved = outcome;
        });
        expect(shell.overlayKind).toBe("permissions");

        openPalette(shell, { catalog: CATALOG });
        expect(shell.overlayKind).toBe("palette");
        expect(shell.paletteCommands[shell.overlayList?.activeIndex ?? -1]?.id).toBe("help");

        acceptOverlaySelection(shell);
        expect(shell.overlayKind).toBe("permissions");
        expect(resolved).toBeUndefined();
        expect(shell.streamLog.some((row) => row.role === "system" && /help/i.test(row.text))).toBe(
          true,
        );

        // Flush-while-busy must keep the deferred slot (the restored gate still
        // holds the host). Dropping it here would lose /help on the next close.
        await Promise.resolve();
        expect(shell.overlayKind).toBe("permissions");

        closeInsetOverlay(shell);
        await Promise.resolve();
        expect(shell.overlayKind).toBe("help");
        expect(resolved).not.toBeUndefined();
      } finally {
        dispose();
      }
    });
  });

  test("live gate plus queued gate plus stacked /help does not arm the queued timeout", async () => {
    await withShell(async ({ shell }) => {
      const emitter = new EventEmitter();
      const dispose = wireGates(emitter, shell);
      try {
        let liveResolved: unknown;
        emitPermissionGate(emitter, (outcome) => {
          liveResolved = outcome;
        });
        expect(shell.overlayKind).toBe("permissions");

        let queuedResolved: unknown;
        emitPermissionGate(
          emitter,
          (outcome) => {
            queuedResolved = outcome;
          },
          { tool: "queued_tool", timeoutMs: 5 },
        );
        expect(shell.overlayKind).toBe("permissions");
        expect(queuedResolved).toBeUndefined();

        openPalette(shell, { catalog: CATALOG });
        const helpIdx = shell.paletteCommands.findIndex((c) => c.id === "help");
        expect(helpIdx).toBeGreaterThanOrEqual(0);
        for (let i = 0; i < helpIdx; i++) moveOverlaySelection(shell, 1);
        expect(shell.paletteCommands[shell.overlayList?.activeIndex ?? -1]?.id).toBe("help");

        acceptOverlaySelection(shell);
        expect(shell.overlayKind).toBe("permissions");

        acceptOverlaySelection(shell);
        await Promise.resolve();
        expect(shell.overlayKind).toBe("help");
        expect(liveResolved).not.toBeUndefined();
        expect(queuedResolved).toBeUndefined();

        await Bun.sleep(20);
        expect(shell.overlayKind).toBe("help");
        expect(queuedResolved).toBeUndefined();

        closeInsetOverlay(shell);
        expect(shell.overlayKind).toBe("permissions");
        expect(queuedResolved).toBeUndefined();
      } finally {
        dispose();
      }
    });
  });

  test("slash accept still drains a queued gate when onCommand throws", async () => {
    await withShell(
      async ({ shell, press }) => {
        const emitter = new EventEmitter();
        const dispose = wireGates(emitter, shell);
        try {
          typePrompt(press, "/compact");
          expect(isSlashPopupOpen(shell)).toBe(true);

          let resolved: unknown;
          emitPermissionGate(emitter, (outcome) => {
            resolved = outcome;
          });
          expect(shell.overlayKind).toBe("palette");
          expect(resolved).toBeUndefined();

          try {
            press("Enter");
          } catch {
            // onCommand throws; idle-notify must still run in finally.
          }
          expect(isSlashPopupOpen(shell)).toBe(false);
          await Bun.sleep(60);
          expect(shell.overlayKind).toBe("permissions");
          expect(resolved).toBeUndefined();
        } finally {
          dispose();
        }
      },
      {
        onCommand: () => {
          throw new Error("dispatch failed");
        },
      },
    );
  });

  test("async /settings list holds the host so a queued gate is not denied", async () => {
    let resolveList: (entries: readonly []) => void = () => undefined;
    const list = new Promise<readonly []>((resolve) => {
      resolveList = resolve;
    });
    await withShell(
      async ({ shell, press }) => {
        const emitter = new EventEmitter();
        const dispose = wireGates(emitter, shell);
        try {
          typePrompt(press, "/settings");
          expect(isSlashPopupOpen(shell)).toBe(true);
          expect(shell.paletteCommands.map((c) => c.id)).toEqual(["settings"]);

          let resolved: unknown;
          emitPermissionGate(emitter, (outcome) => {
            resolved = outcome;
          });
          expect(shell.overlayKind).toBe("palette");
          expect(resolved).toBeUndefined();

          press("Enter");
          expect(isSlashPopupOpen(shell)).toBe(false);
          expect(shell.overlayKind).not.toBe("permissions");
          expect(shell.overlayKind).not.toBe("settings");
          expect(resolved).toBeUndefined();

          resolveList([]);
          await Promise.resolve();
          await Promise.resolve();
          expect(shell.overlayKind).toBe("settings");
          expect(resolved).toBeUndefined();

          closeInsetOverlay(shell);
          await Bun.sleep(60);
          expect(shell.overlayKind).toBe("permissions");
          expect(resolved).toBeUndefined();
        } finally {
          dispose();
        }
      },
      {
        onCommand: (name, shell) => {
          if (name !== "settings") return;
          const deps: CommandSurfaceDeps = {
            notify: () => undefined,
            settings: {
              read: () => ({
                compactionMode: "llm",
                waitForApproval: true,
                telemetryEnabled: false,
                showPromptCost: false,
              }),
              setCompactionMode: () => undefined,
              setWaitForApproval: () => undefined,
              setTelemetryEnabled: () => undefined,
              setShowPromptCost: () => undefined,
            },
            permissions: {
              list: () => list,
              revoke: () => Promise.resolve(),
            },
          };
          openCommandSurface(shell, "settings", deps);
        },
      },
    );
  });

  test("palette stacked over a live gate defers async /settings until the gate closes", async () => {
    let resolveList: (entries: readonly []) => void = () => undefined;
    const list = new Promise<readonly []>((resolve) => {
      resolveList = resolve;
    });
    await withShell(
      async ({ shell }) => {
        const emitter = new EventEmitter();
        const dispose = wireGates(emitter, shell);
        try {
          let resolved: unknown;
          emitPermissionGate(emitter, (outcome) => {
            resolved = outcome;
          });
          expect(shell.overlayKind).toBe("permissions");

          openPalette(shell, { catalog: CATALOG });
          const settingsIdx = shell.paletteCommands.findIndex((c) => c.id === "settings");
          expect(settingsIdx).toBeGreaterThanOrEqual(0);
          for (let i = 0; i < settingsIdx; i++) moveOverlaySelection(shell, 1);
          expect(shell.paletteCommands[shell.overlayList?.activeIndex ?? -1]?.id).toBe("settings");

          acceptOverlaySelection(shell);
          expect(shell.overlayKind).toBe("permissions");
          expect(resolved).toBeUndefined();

          resolveList([]);
          await Promise.resolve();
          await Promise.resolve();
          expect(shell.overlayKind).toBe("permissions");
          expect(resolved).toBeUndefined();
          expect(
            shell.streamLog.some((row) => row.role === "system" && /settings/i.test(row.text)),
          ).toBe(true);

          closeInsetOverlay(shell);
          await Promise.resolve();
          expect(shell.overlayKind).toBe("settings");
          expect(resolved).not.toBeUndefined();
        } finally {
          dispose();
        }
      },
      {
        onCommand: (name, shell) => {
          if (name !== "settings") return;
          const deps: CommandSurfaceDeps = {
            notify: () => undefined,
            settings: {
              read: () => ({
                compactionMode: "llm",
                waitForApproval: true,
                telemetryEnabled: false,
                showPromptCost: false,
              }),
              setCompactionMode: () => undefined,
              setWaitForApproval: () => undefined,
              setTelemetryEnabled: () => undefined,
              setShowPromptCost: () => undefined,
            },
            permissions: {
              list: () => list,
              revoke: () => Promise.resolve(),
            },
          };
          openCommandSurface(shell, "settings", deps);
        },
      },
    );
  });

  test("palette stacked over a live gate defers /mcp until the gate closes", async () => {
    await withShell(
      async ({ shell }) => {
        const emitter = new EventEmitter();
        const dispose = wireGates(emitter, shell);
        try {
          let resolved: unknown;
          emitPermissionGate(emitter, (outcome) => {
            resolved = outcome;
          });
          expect(shell.overlayKind).toBe("permissions");

          openPalette(shell, { catalog: CATALOG });
          const mcpIdx = shell.paletteCommands.findIndex((c) => c.id === "mcp");
          expect(mcpIdx).toBeGreaterThanOrEqual(0);
          for (let i = 0; i < mcpIdx; i++) moveOverlaySelection(shell, 1);
          expect(shell.paletteCommands[shell.overlayList?.activeIndex ?? -1]?.id).toBe("mcp");

          acceptOverlaySelection(shell);
          expect(shell.overlayKind).toBe("permissions");
          expect(resolved).toBeUndefined();
          expect(
            shell.streamLog.some((row) => row.role === "system" && /mcp/i.test(row.text)),
          ).toBe(true);

          closeInsetOverlay(shell);
          await Promise.resolve();
          expect(shell.overlayKind).toBe("mcp");
          expect(resolved).not.toBeUndefined();
        } finally {
          dispose();
        }
      },
      {
        onCommand: (name, shell) => {
          if (name !== "mcp") return;
          openCommandSurface(shell, "mcp", {
            notify: () => undefined,
            mcp: {
              list: () => [],
              openAuthURL: () => undefined,
            },
          });
        },
      },
    );
  });
});

describe("overlay host occupancy and opt-in deferral", () => {
  test("a permission event during /settings list() reservation does not take the host", async () => {
    const hanging = hangingSettingsList();
    await withShell(
      async ({ shell, press }) => {
        const emitter = new EventEmitter();
        const dispose = wireGates(emitter, shell);
        try {
          typePrompt(press, "/settings");
          press("Enter");
          expect(shell.overlayKind).not.toBe("settings");
          expect(shell.overlayKind).not.toBe("permissions");

          let resolved: unknown;
          emitPermissionGate(
            emitter,
            (outcome) => {
              resolved = outcome;
            },
            { timeoutMs: 5 },
          );
          expect(shell.overlayKind).not.toBe("permissions");
          expect(resolved).toBeUndefined();

          hanging.resolve();
          await Promise.resolve();
          await Promise.resolve();
          expect(shell.overlayKind).toBe("settings");
          expect(resolved).toBeUndefined();

          await Bun.sleep(20);
          expect(shell.overlayKind).toBe("settings");
          expect(resolved).toBeUndefined();

          closeInsetOverlay(shell);
          await Promise.resolve();
          await Promise.resolve();
          expect(shell.overlayKind).toBe("permissions");
          expect(resolved).toBeUndefined();
        } finally {
          dispose();
        }
      },
      { onCommand: settingsOnCommand(hanging.list) },
    );
  });

  test("busy openListOverlay without deferIfBusy is a silent no-op", async () => {
    await withShell(async ({ shell }) => {
      openListOverlay(shell, { kind: "demo", items: ["first"] });
      expect(shell.overlayItems[0]).toBe("first");

      openListOverlay(shell, { kind: "demo", items: ["second"] });
      expect(shell.overlayItems[0]).toBe("first");
      expect(
        shell.streamLog.some((row) => row.role === "system" && /will open/i.test(row.text)),
      ).toBe(false);

      closeInsetOverlay(shell);
      await Promise.resolve();
      expect(shell.overlayList).toBeNull();
    });
  });

  test("closeReplaceableOverlay leaves an isGate overlay and replaces admin permissions", async () => {
    await withShell(async ({ shell }) => {
      const emitter = new EventEmitter();
      const dispose = wireGates(emitter, shell);
      try {
        emitPermissionGate(emitter, () => undefined);
        expect(shell.overlayKind).toBe("permissions");
        closeReplaceableOverlay(shell);
        expect(shell.overlayKind).toBe("permissions");
        closeInsetOverlay(shell);
      } finally {
        dispose();
      }

      openPermissionsOverlay(shell, {
        items: ["Allow once", "Deny"],
        onCancel: () => undefined,
      });
      expect(shell.overlayKind).toBe("permissions");
      closeReplaceableOverlay(shell);
      expect(shell.overlayList).toBeNull();

      openCommandSurface(shell, "permissions", {
        notify: () => undefined,
        permissions: {
          list: () => Promise.resolve([]),
          revoke: () => Promise.resolve(),
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(shell.overlayKind).toBe("permissions");
      closeReplaceableOverlay(shell);
      expect(shell.overlayList).toBeNull();
    });
  });

  test("accepting plugins from settings while a gate is queued opens plugins", async () => {
    const hanging = hangingSettingsList();
    await withShell(async ({ shell }) => {
      const emitter = new EventEmitter();
      const dispose = wireGates(emitter, shell);
      try {
        openCommandSurface(shell, "settings", {
          notify: () => undefined,
          settings: {
            read: () => ({
              compactionMode: "llm",
              waitForApproval: true,
              telemetryEnabled: false,
              showPromptCost: false,
            }),
            setCompactionMode: () => undefined,
            setWaitForApproval: () => undefined,
            setTelemetryEnabled: () => undefined,
            setShowPromptCost: () => undefined,
          },
          permissions: {
            list: () => hanging.list,
            revoke: () => Promise.resolve(),
          },
          plugins: {
            list: () => [],
            setEnabled: () => Promise.resolve(undefined),
          } as unknown as PluginsSurfaceDeps,
        });
        hanging.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(shell.overlayKind).toBe("settings");

        let resolved: unknown;
        emitPermissionGate(emitter, (outcome) => {
          resolved = outcome;
        });
        expect(shell.overlayKind).toBe("settings");
        expect(resolved).toBeUndefined();

        const pluginsIdx = shell.overlayItems.findIndex((row) => row.includes("plugins"));
        expect(pluginsIdx).toBeGreaterThanOrEqual(0);
        for (let i = 0; i < pluginsIdx; i++) moveOverlaySelection(shell, 1);
        acceptOverlaySelection(shell);
        expect(shell.overlayKind).toBe("plugins");
        expect(resolved).toBeUndefined();
      } finally {
        dispose();
      }
    });
  });

  test("same-kind /help replaces the live help list instead of deferring", async () => {
    await withShell(async ({ shell, press, render }) => {
      openHelpOverlay(shell);
      expect(shell.overlayKind).toBe("help");
      openHelpOverlay(shell);
      expect(shell.overlayKind).toBe("help");
      expect(
        shell.streamLog.some((row) => row.role === "system" && /will open/i.test(row.text)),
      ).toBe(false);
      press("Escape");
      await render();
      await Bun.sleep(60);
      expect(shell.overlayList).toBeNull();
    });
  });

  test("/help replaces an overlay whose onCancel would reopen another list", async () => {
    await withShell(async ({ shell }) => {
      openListOverlay(shell, {
        kind: "add_provider",
        items: ["openai"],
        onCancel: () => {
          openListOverlay(shell, {
            kind: "model_picker",
            items: ["model-a"],
            deferIfBusy: true,
          });
        },
      });
      expect(shell.overlayKind).toBe("add_provider");
      openHelpOverlay(shell);
      expect(shell.overlayKind).toBe("help");
      expect(
        shell.streamLog.some((row) => row.role === "system" && /will open/i.test(row.text)),
      ).toBe(false);
    });
  });

  test("Esc during /settings list() reservation does not paint settings", async () => {
    const hanging = hangingSettingsList();
    await withShell(
      async ({ shell, press, render }) => {
        const emitter = new EventEmitter();
        const dispose = wireGates(emitter, shell);
        try {
          typePrompt(press, "/settings");
          press("Enter");
          expect(shell.overlayKind).not.toBe("settings");
          expect(shell.overlayKind).not.toBe("permissions");

          press("Escape");
          await render();
          await Bun.sleep(60);
          hanging.resolve();
          await Promise.resolve();
          await Promise.resolve();
          expect(shell.overlayKind).not.toBe("settings");
        } finally {
          dispose();
        }
      },
      { onCommand: settingsOnCommand(hanging.list) },
    );
  });

  test("Esc while settings is painted during a cycle list() does not resurrect settings", async () => {
    let listCalls = 0;
    let resolveSecond: () => void = () => undefined;
    const second = new Promise<readonly []>((resolve) => {
      resolveSecond = () => resolve([]);
    });
    await withShell(
      async ({ shell, press, render }) => {
        typePrompt(press, "/settings");
        press("Enter");
        await Promise.resolve();
        await Promise.resolve();
        expect(shell.overlayKind).toBe("settings");

        expect(cycleOverlaySelection(shell, 1)).toBe(true);
        expect(listCalls).toBe(2);

        press("Escape");
        await render();
        await Bun.sleep(60);
        resolveSecond();
        await Promise.resolve();
        await Promise.resolve();
        expect(shell.overlayKind).not.toBe("settings");
      },
      {
        onCommand: (name, shell) => {
          if (name !== "settings") return;
          openCommandSurface(shell, "settings", {
            notify: () => undefined,
            settings: {
              read: () => ({
                compactionMode: "llm",
                waitForApproval: true,
                telemetryEnabled: false,
                showPromptCost: false,
              }),
              setCompactionMode: () => undefined,
              setWaitForApproval: () => undefined,
              setTelemetryEnabled: () => undefined,
              setShowPromptCost: () => undefined,
            },
            permissions: {
              list: () => {
                listCalls += 1;
                if (listCalls === 1) return Promise.resolve([]);
                return second;
              },
              revoke: () => Promise.resolve(),
            },
          });
        },
      },
    );
  });

  test("re-opening help while a gate is queued does not drain the gate", async () => {
    await withShell(async ({ shell }) => {
      const emitter = new EventEmitter();
      const dispose = wireGates(emitter, shell);
      try {
        openHelpOverlay(shell);
        expect(shell.overlayKind).toBe("help");

        let resolved: unknown;
        emitPermissionGate(emitter, (outcome) => {
          resolved = outcome;
        });
        expect(shell.overlayKind).toBe("help");
        expect(resolved).toBeUndefined();

        openHelpOverlay(shell);
        expect(shell.overlayKind).toBe("help");
        expect(resolved).toBeUndefined();
      } finally {
        dispose();
      }
    });
  });

  test("settings list() aborts when a newer overlay takes the host", async () => {
    const hanging = hangingSettingsList();
    await withShell(
      async ({ shell, press }) => {
        const emitter = new EventEmitter();
        const dispose = wireGates(emitter, shell);
        try {
          typePrompt(press, "/settings");
          press("Enter");
          expect(shell.overlayKind).not.toBe("settings");

          let resolved: unknown;
          emitPermissionGate(emitter, (outcome) => {
            resolved = outcome;
          });
          expect(shell.overlayKind).not.toBe("permissions");

          openHelpOverlay(shell);
          expect(shell.overlayKind).toBe("help");

          hanging.resolve();
          await Promise.resolve();
          await Promise.resolve();
          expect(shell.overlayKind).toBe("help");
          expect(resolved).toBeUndefined();

          closeInsetOverlay(shell);
          await Bun.sleep(60);
          expect(shell.overlayKind).toBe("permissions");
          expect(resolved).toBeUndefined();
        } finally {
          dispose();
        }
      },
      { onCommand: settingsOnCommand(hanging.list) },
    );
  });
});
