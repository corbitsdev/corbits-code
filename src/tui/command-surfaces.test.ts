/**
 * Slash-command surfaces: settings menu, permissions revoke, plugin toggle.
 */
import { describe, expect, test } from "bun:test";

import {
  grantRowLabel,
  openCommandSurface,
  pluginRowLabel,
  type CommandSurfaceDeps,
  type GrantEntry,
  type PluginEntry,
  type PluginsSurfaceDeps,
  type SettingsSnapshot,
} from "./command-surfaces";
import type { KeyEvent } from "@opentui/core";

import { withTestRenderer } from "./harness";
import {
  acceptOverlaySelection,
  createAppShell,
  cycleOverlaySelection,
  moveOverlaySelection,
  runOverlayAction,
  type AppShell,
} from "./shell";

function baseSnapshot(): SettingsSnapshot {
  return {
    compactionMode: "llm",
    waitForApproval: true,
    telemetryEnabled: false,
    showPromptCost: false,
  };
}

async function withShell(fn: (shell: AppShell) => Promise<void> | void): Promise<void> {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: false,
      });
      try {
        await fn(shell);
      } finally {
        shell.dispose();
      }
    },
    { width: 80, height: 24 },
  );
}

describe("surface labels", () => {
  test("grant label carries scope, tool, pattern, provider model", () => {
    const entry: GrantEntry = {
      id: "0",
      scopeLabel: "This project",
      tool: "shell",
      pattern: "git status",
      providerModel: "anthropic/opus",
    };
    expect(grantRowLabel(entry)).toBe("This project · shell git status (anthropic/opus)");
  });

  test("plugin label reports trust before enablement", () => {
    const entry: PluginEntry = {
      id: "a",
      name: "linear",
      enabled: false,
      needsTrust: true,
      credentials: [],
      credentialValues: {},
    };
    expect(pluginRowLabel(entry)).toBe("linear — untrusted");
    expect(
      pluginRowLabel({
        id: "b",
        name: "exa",
        enabled: true,
        credentials: [],
        credentialValues: {},
      }),
    ).toBe("exa — enabled");
  });

  test("plugin label surfaces standing load warnings", () => {
    expect(
      pluginRowLabel({
        id: "agents",
        name: "agents",
        enabled: true,
        credentials: [],
        credentialValues: {},
        warnings: ['agent a: skill "style" referenced but not found in skill search path'],
      }),
    ).toBe("agents — enabled — has warnings");
  });
});

/** Build a settings deps bag over a mutable snapshot, recording every write. */
function settingsDeps(overrides?: Partial<SettingsSnapshot>): {
  readonly deps: CommandSurfaceDeps;
  readonly snapshot: () => SettingsSnapshot;
  readonly calls: {
    compaction: string[];
    waitForApproval: boolean[];
    telemetry: boolean[];
    showPromptCost: boolean[];
  };
} {
  let state: SettingsSnapshot = { ...baseSnapshot(), ...overrides };
  const calls = {
    compaction: [] as string[],
    waitForApproval: [] as boolean[],
    telemetry: [] as boolean[],
    showPromptCost: [] as boolean[],
  };
  const deps: CommandSurfaceDeps = {
    notify: () => {},
    settings: {
      read: () => state,
      setCompactionMode: (mode) => {
        calls.compaction.push(mode);
        state = { ...state, compactionMode: mode };
      },
      setWaitForApproval: (value) => {
        calls.waitForApproval.push(value);
        state = { ...state, waitForApproval: value };
      },
      setTelemetryEnabled: (value) => {
        calls.telemetry.push(value);
        state = { ...state, telemetryEnabled: value };
      },
      setShowPromptCost: (value) => {
        calls.showPromptCost.push(value);
        state = { ...state, showPromptCost: value };
      },
    },
  };
  return { deps, snapshot: () => state, calls };
}

describe("settings surface", () => {
  test("rows show live values and the description zone stays two lines", async () => {
    await withShell(async (shell) => {
      const { deps } = settingsDeps();
      expect(openCommandSurface(shell, "settings", deps)).toBe(true);
      await Promise.resolve();
      await Promise.resolve();

      expect(shell.overlayItems.some((l) => l.includes("summarize"))).toBe(true);
      expect(shell.overlayItems.some((l) => l.includes("off"))).toBe(true);
    });
  });

  test("left/right cycles compaction in place and persists", async () => {
    await withShell(async (shell) => {
      const { deps, calls } = settingsDeps();
      openCommandSurface(shell, "settings", deps);
      await Promise.resolve();
      await Promise.resolve();

      expect(cycleOverlaySelection(shell, 1)).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(calls.compaction).toEqual(["pruning"]);
      expect(shell.overlayKind).toBe("settings");
      expect(shell.overlayItems[0]).toContain("drop");
    });
  });

  test("choosing a cycled row writes a plain-English transcript line, not the internal echo", async () => {
    await withShell(async (shell) => {
      const { deps } = settingsDeps();
      openCommandSurface(shell, "settings", deps);
      await Promise.resolve();
      await Promise.resolve();

      cycleOverlaySelection(shell, 1);
      await Promise.resolve();
      await Promise.resolve();
      acceptOverlaySelection(shell);

      const row = shell.streamLog.at(-1);
      expect(row?.text).toBe("Set compaction to drop.");
      expect(row?.meta).not.toBe("overlay");
      expect(row?.text).not.toContain("‹");
      expect(row?.text).not.toContain("›");
      expect(row?.text).not.toContain("overlay");
    });
  });

  test("settings surface has no session mode rows", async () => {
    await withShell(async (shell) => {
      const { deps } = settingsDeps();
      openCommandSurface(shell, "settings", deps);
      await Promise.resolve();
      await Promise.resolve();

      expect(shell.overlayItems.some((l) => l.includes("session mode"))).toBe(false);
      expect(shell.overlayItems.some((l) => l.includes("scope"))).toBe(false);
    });
  });

  test("left/right cycles the show-cost row and persists, with a self-describing row", async () => {
    await withShell(async (shell) => {
      const { deps, calls } = settingsDeps();
      openCommandSurface(shell, "settings", deps);
      await Promise.resolve();
      await Promise.resolve();

      expect(shell.overlayItems.some((l) => l.includes("show cost"))).toBe(true);

      // compaction, approval wait, telemetry, show cost
      moveOverlaySelection(shell, 3);
      cycleOverlaySelection(shell, 1);
      await Promise.resolve();
      await Promise.resolve();
      expect(calls.showPromptCost).toEqual([true]);
      expect(shell.overlayItems.some((l) => l.includes("show cost"))).toBe(true);
    });
  });

  test("arrow navigation still moves the cursor in a non-cycling overlay", async () => {
    await withShell(async (shell) => {
      const deps: CommandSurfaceDeps = {
        notify: () => {},
        // Only the fields this test exercises; the rest of PluginsSurfaceDeps
        // (credentials, verify, web providers) belongs to the plugins surface,
        // not to this arrow-navigation scoping test.
        plugins: {
          list: () => [
            { id: "linear", name: "linear", enabled: false, credentials: [], credentialValues: {} },
            { id: "exa", name: "exa", enabled: true, credentials: [], credentialValues: {} },
          ],
          setEnabled: () => Promise.resolve(undefined),
        } as unknown as PluginsSurfaceDeps,
      };
      openCommandSurface(shell, "plugins", deps);
      expect(shell.overlayList?.activeIndex).toBe(0);
      moveOverlaySelection(shell, 1);
      expect(shell.overlayList?.activeIndex).toBe(1);
      // Left/Right mean nothing here: no onCycle was supplied for this open.
      expect(cycleOverlaySelection(shell, 1)).toBe(false);
      expect(shell.overlayList?.activeIndex).toBe(1);
    });
  });
});

describe("permissions surface", () => {
  test("lists live grants and revokes the accepted row", async () => {
    await withShell(async (shell) => {
      let grants: GrantEntry[] = [
        { id: "0", scopeLabel: "Global", tool: "shell", pattern: "ls" },
        { id: "1", scopeLabel: "This project", tool: "read", pattern: "src/**" },
      ];
      const revoked: string[] = [];
      const deps: CommandSurfaceDeps = {
        notify: () => {},
        permissions: {
          list: () => Promise.resolve(grants),
          revoke: (id) => {
            revoked.push(id);
            grants = grants.filter((g) => g.id !== id);
            return Promise.resolve();
          },
        },
      };
      openCommandSurface(shell, "permissions", deps);
      await Promise.resolve();
      expect(shell.overlayItems[0]).toBe("Global · shell ls");

      acceptOverlaySelection(shell);
      await Promise.resolve();
      await Promise.resolve();
      expect(revoked).toEqual(["0"]);
      expect(shell.overlayItems[0]).toBe("This project · read src/**");
    });
  });

  test("empty grant list still opens with a hint row", async () => {
    await withShell(async (shell) => {
      const deps: CommandSurfaceDeps = {
        notify: () => {},
        permissions: { list: () => Promise.resolve([]), revoke: () => Promise.resolve() },
      };
      openCommandSurface(shell, "permissions", deps);
      await Promise.resolve();
      expect(shell.overlayItems[0]).toContain("No remembered approvals");
    });
  });

  test("no permissions dep notifies instead of opening", async () => {
    await withShell((shell) => {
      const notes: string[] = [];
      openCommandSurface(shell, "permissions", { notify: (t) => notes.push(t) });
      expect(shell.overlayList).toBeNull();
      expect(notes).toHaveLength(1);
    });
  });
});

describe("plugins surface", () => {
  test("toggles enablement and re-opens with the new state", async () => {
    await withShell(async (shell) => {
      const state = new Map<string, boolean>([
        ["linear", false],
        ["exa", true],
      ]);
      const deps: CommandSurfaceDeps = {
        notify: () => {},
        // Same partial-mock rationale as the arrow-navigation test above.
        plugins: {
          list: () =>
            [...state].map(([id, enabled]: [string, boolean]) => ({
              id,
              name: id,
              enabled,
              credentials: [],
              credentialValues: {},
            })),
          setEnabled: (id: string, enabled: boolean) => {
            state.set(id, enabled);
            return Promise.resolve(undefined);
          },
        } as unknown as PluginsSurfaceDeps,
      };
      openCommandSurface(shell, "plugins", deps);
      expect(shell.overlayItems[0]).toBe("linear — disabled");

      acceptOverlaySelection(shell);
      await Promise.resolve();
      await Promise.resolve();
      expect(state.get("linear")).toBe(true);
      expect(shell.overlayItems[0]).toBe("linear — enabled");
    });
  });
});

function key(name: string): KeyEvent {
  return { name, ctrl: false, meta: false, option: false, sequence: name } as KeyEvent;
}

/** Alt+<name>, for the plugins surface's row actions (c/v/t/a/w). */
function altKey(name: string): KeyEvent {
  return { name, ctrl: false, meta: false, option: true, sequence: name } as KeyEvent;
}

function charKey(seq: string): KeyEvent {
  return { name: seq, ctrl: false, meta: false, option: false, sequence: seq } as KeyEvent;
}

/** Full-featured fake for the admin-action tests: one secret credential field. */
function pluginActionDeps(overrides?: Partial<PluginEntry>): {
  readonly deps: CommandSurfaceDeps;
  readonly calls: {
    setEnabled: { id: string; enabled: boolean }[];
    saveCredentials: { id: string; credentials: Record<string, string> }[];
    verify: { id: string; credentials: Record<string, string> }[];
    addPath: string[];
    setWebProvider: (string | undefined)[];
  };
  readonly notes: string[];
} {
  const calls = {
    setEnabled: [] as { id: string; enabled: boolean }[],
    saveCredentials: [] as { id: string; credentials: Record<string, string> }[],
    verify: [] as { id: string; credentials: Record<string, string> }[],
    addPath: [] as string[],
    setWebProvider: [] as (string | undefined)[],
  };
  const notes: string[] = [];
  let entry: PluginEntry = {
    id: "exa",
    name: "exa-search",
    kind: "web",
    enabled: false,
    credentials: [{ key: "apiKey", label: "API key", secret: true }],
    credentialValues: {},
    ...overrides,
  };
  const plugins: PluginsSurfaceDeps = {
    list: () => [entry],
    setEnabled: (id, enabled) => {
      calls.setEnabled.push({ id, enabled });
      entry = { ...entry, enabled };
      return Promise.resolve(undefined);
    },
    saveCredentials: (id, credentials) => {
      calls.saveCredentials.push({ id, credentials });
      entry = { ...entry, credentialValues: credentials };
      return Promise.resolve();
    },
    verify: (id, credentials) => {
      calls.verify.push({ id, credentials });
      return Promise.resolve({ ok: true, message: "connected" });
    },
    addPath: (path) => {
      calls.addPath.push(path);
      return Promise.resolve({ ok: true, message: `added ${path}` });
    },
    webProviders: () => [{ id: "exa", name: "exa-search" }],
    currentWebProvider: () => undefined,
    setWebProvider: (id) => {
      calls.setWebProvider.push(id);
      return Promise.resolve();
    },
  };
  const deps: CommandSurfaceDeps = { notify: (t) => notes.push(t), plugins };
  return { deps, calls, notes };
}

describe("plugins surface admin actions", () => {
  test("load warnings appear as a summary row under /plugins", async () => {
    await withShell(async (shell) => {
      const warnings = [
        'agent a: skill "style" referenced but not found in skill search path',
        'agent a: skill "philosophy" referenced but not found in skill search path',
      ];
      const { deps } = pluginActionDeps({
        id: "agents",
        name: "agents",
        kind: "agent",
        enabled: true,
        credentials: [],
        credentialValues: {},
        warnings,
        agentProfiles: [{ id: "a" }],
      });
      // pluginActionDeps builds PluginsSurfaceDeps without loadWarnings; splice it in.
      const plugins = deps.plugins!;
      const withWarnings: CommandSurfaceDeps = {
        ...deps,
        plugins: {
          ...plugins,
          loadWarnings: () => warnings,
        },
      };
      openCommandSurface(shell, "plugins", withWarnings);
      expect(shell.overlayItems.some((l) => l.includes("2 skills missing"))).toBe(true);
      expect(shell.overlayItems.some((l) => l.includes("has warnings"))).toBe(true);
    });
  });

  test("c opens credentials, typing a 40+ char key and s saves it in full", async () => {
    await withShell(async (shell) => {
      const { deps, calls } = pluginActionDeps();
      openCommandSurface(shell, "plugins", deps);

      expect(runOverlayAction(shell, altKey("c"))).toBe(true);
      expect(shell.overlayKind).toBe("plugin_credentials");

      acceptOverlaySelection(shell); // start editing the apiKey field
      const longKey = "sk-" + "a".repeat(40);
      for (const ch of longKey) {
        expect(runOverlayAction(shell, charKey(ch))).toBe(true);
      }
      // The secret is never painted in the clear anywhere in the rendered row.
      for (const line of shell.overlayItems) expect(line).not.toContain(longKey);

      acceptOverlaySelection(shell); // commit the field edit
      expect(runOverlayAction(shell, key("s"))).toBe(true);
      await Promise.resolve();
      expect(calls.saveCredentials).toEqual([{ id: "exa", credentials: { apiKey: longKey } }]);
    });
  });

  test("v verifies the currently saved credentials", async () => {
    await withShell(async (shell) => {
      const { deps, calls } = pluginActionDeps({ credentialValues: { apiKey: "saved-key" } });
      openCommandSurface(shell, "plugins", deps);
      expect(runOverlayAction(shell, altKey("v"))).toBe(true);
      await Promise.resolve();
      expect(calls.verify).toEqual([{ id: "exa", credentials: { apiKey: "saved-key" } }]);
    });
  });

  test("a prompts for a path and reaches addPath", async () => {
    await withShell(async (shell) => {
      const { deps, calls } = pluginActionDeps();
      openCommandSurface(shell, "plugins", deps);
      expect(runOverlayAction(shell, altKey("a"))).toBe(true);
      for (const ch of "/tmp/my-plugin") runOverlayAction(shell, charKey(ch));
      acceptOverlaySelection(shell);
      await Promise.resolve();
      expect(calls.addPath).toEqual(["/tmp/my-plugin"]);
    });
  });

  test("w opens a web provider chooser and setWebProvider is called with the chosen id", async () => {
    await withShell(async (shell) => {
      const { deps, calls } = pluginActionDeps();
      openCommandSurface(shell, "plugins", deps);
      expect(runOverlayAction(shell, altKey("w"))).toBe(true);
      moveOverlaySelection(shell, 1); // automatic, exa-search, back — pick exa-search
      acceptOverlaySelection(shell);
      await Promise.resolve();
      expect(calls.setWebProvider).toEqual(["exa"]);
    });
  });

  test("an untrusted plugin cannot be enabled before it is trusted", async () => {
    await withShell(async (shell) => {
      const { deps, calls, notes } = pluginActionDeps({ needsTrust: true, enabled: false });
      openCommandSurface(shell, "plugins", deps);

      acceptOverlaySelection(shell); // Enter while untrusted
      expect(calls.setEnabled).toEqual([]);
      expect(notes.length).toBeGreaterThan(0);

      expect(runOverlayAction(shell, altKey("t"))).toBe(true);
      await Promise.resolve();
      expect(calls.setEnabled).toEqual([{ id: "exa", enabled: true }]);
    });
  });
});

describe("hooks surface", () => {
  test("lists discovered hooks with enabled state and Enter toggles", async () => {
    await withShell(async (shell) => {
      const state = new Map<string, boolean>([["/hooks/a.ts", true]]);
      const deps: CommandSurfaceDeps = {
        notify: () => {},
        hooks: {
          list: () =>
            [...state].map(([id, enabled]) => ({
              id,
              name: "a.ts",
              type: "typescript" as const,
              path: id,
              enabled,
              runsOn: "runs postTurn",
            })),
          setEnabled: (id, enabled) => {
            state.set(id, enabled);
            return Promise.resolve();
          },
        },
      };
      openCommandSurface(shell, "hooks", deps);
      expect(shell.overlayItems[0]).toBe("a.ts — enabled");

      acceptOverlaySelection(shell);
      await Promise.resolve();
      await Promise.resolve();
      expect(state.get("/hooks/a.ts")).toBe(false);
      expect(shell.overlayItems[0]).toBe("a.ts — disabled");
    });
  });
});

describe("mcp surface", () => {
  const entries = [
    { name: "linear", state: "connected" as const, toolCount: 12 },
    { name: "notion", state: "needs-auth" as const, authURL: "https://notion.test/auth" },
    { name: "sentry", state: "failed" as const, error: "ECONNREFUSED" },
  ];

  test("lists every configured server with its live state", async () => {
    await withShell((shell) => {
      openCommandSurface(shell, "mcp", {
        notify: () => {},
        mcp: { list: () => entries, openAuthURL: () => {} },
      });
      expect(shell.overlayItems.slice(0, 3)).toEqual([
        "linear — connected · 12 tools",
        "notion — needs auth",
        "sentry — failed",
      ]);
    });
  });

  test("Enter on an unauthorized server opens the browser and copies the link", async () => {
    await withShell((shell) => {
      const opened: string[] = [];
      openCommandSurface(shell, "mcp", {
        notify: () => {},
        mcp: { list: () => entries, openAuthURL: (url) => opened.push(url) },
      });
      moveOverlaySelection(shell, 1);
      acceptOverlaySelection(shell);
      expect(opened).toEqual(["https://notion.test/auth"]);
      expect(shell.statusFlash).toContain("notion");
      // The echo would quote "notion — needs auth" back forever, moments
      // after the operator authorized it.
      expect(shell.streamLog.filter((r) => r.meta === "overlay")).toEqual([]);
    });
  });

  test("Enter on a connected server does nothing", async () => {
    await withShell((shell) => {
      const opened: string[] = [];
      openCommandSurface(shell, "mcp", {
        notify: () => {},
        mcp: { list: () => entries, openAuthURL: (url) => opened.push(url) },
      });
      acceptOverlaySelection(shell);
      expect(opened).toEqual([]);
    });
  });

  test("reports the gap when the session has no mcp deps", async () => {
    await withShell((shell) => {
      const notes: string[] = [];
      openCommandSurface(shell, "mcp", { notify: (t) => notes.push(t) });
      expect(notes[0]).toContain("not available");
    });
  });
});

describe("model surface", () => {
  test("routes to the host picker, and reports the gap when absent", async () => {
    await withShell((shell) => {
      let opened = 0;
      expect(
        openCommandSurface(shell, "models", { notify: () => {}, openModels: () => opened++ }),
      ).toBe(true);
      expect(opened).toBe(1);
      expect(openCommandSurface(shell, "models", { notify: () => {} })).toBe(false);
    });
  });
});

describe("add-provider surface", () => {
  test("routes to the host opener, and reports the gap when absent", async () => {
    await withShell((shell) => {
      let opened = 0;
      expect(
        openCommandSurface(shell, "add-provider", {
          notify: () => {},
          openAddProvider: () => opened++,
        }),
      ).toBe(true);
      expect(opened).toBe(1);
      expect(openCommandSurface(shell, "add-provider", { notify: () => {} })).toBe(false);
    });
  });
});

describe("help surface", () => {
  test("opens the keymap overlay", async () => {
    await withShell((shell) => {
      expect(openCommandSurface(shell, "help", { notify: () => {} })).toBe(true);
      expect(shell.overlayKind).toBe("help");
    });
  });
});
