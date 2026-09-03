/**
 * Slash-command surfaces: settings menu, permissions revoke, plugin toggle.
 */
import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  grantRowLabel,
  openCommandSurface,
  pluginDescription,
  pluginRowLabel,
  type CommandSurfaceDeps,
  type GrantEntry,
  type McpEntry,
  type PluginEntry,
  type PluginsSurfaceDeps,
  type SettingsSnapshot,
} from "./command-surfaces";
import type { KeyEvent } from "@opentui/core";

import { focusOwner } from "./focus/index.js";
import { withTestRenderer, type Harness } from "./harness";
import { projectPluginsRoot, userPluginsRoot } from "../plugins/uninstall.js";
import {
  acceptOverlaySelection,
  closeInsetOverlay,
  createAppShell,
  cycleOverlaySelection,
  moveOverlaySelection,
  openListOverlay,
  openPalette,
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

async function withWiredShell(
  fn: (shell: AppShell, harness: Harness) => Promise<void> | void,
): Promise<void> {
  await withTestRenderer(
    async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        wireKeys: true,
      });
      try {
        await fn(shell, h);
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
      origin: "project",
    };
    expect(pluginRowLabel(entry)).toBe("linear — untrusted");
    expect(
      pluginRowLabel({
        id: "b",
        name: "exa",
        enabled: true,
        credentials: [],
        credentialValues: {},
        origin: "user",
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
        origin: "user",
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
function pluginActionDeps(
  overrides?: Partial<PluginEntry>,
  roots?: { readonly cwd?: string; readonly home?: string },
): {
  readonly deps: CommandSurfaceDeps;
  readonly calls: {
    setEnabled: { id: string; enabled: boolean }[];
    saveCredentials: { id: string; credentials: Record<string, string> }[];
    verify: { id: string; credentials: Record<string, string> }[];
    addPath: string[];
    remove: string[];
    setWebProvider: (string | undefined)[];
  };
  readonly notes: string[];
} {
  const calls = {
    setEnabled: [] as { id: string; enabled: boolean }[],
    saveCredentials: [] as { id: string; credentials: Record<string, string> }[],
    verify: [] as { id: string; credentials: Record<string, string> }[],
    addPath: [] as string[],
    remove: [] as string[],
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
    origin: "user",
    ...overrides,
  };
  const plugins: PluginsSurfaceDeps = {
    cwd: roots?.cwd ?? process.cwd(),
    home: roots?.home ?? homedir(),
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
    remove: (id) => {
      calls.remove.push(id);
      return Promise.resolve({
        ok: true,
        message:
          entry.origin === "repo"
            ? `${entry.name} is bundled and cannot be uninstalled — disabled instead.`
            : `Removed ${entry.name}.`,
      });
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
      expect(shell.overlayKind).toBe("plugin_credentials");
      expect(shell.overlayKind).not.toBe("plugins");
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

  test("owned user Alt+X opens confirm; accept calls remove; cancel/Esc does not", async () => {
    await withShell(async (shell) => {
      const { deps, calls } = pluginActionDeps({
        origin: "user",
        pluginPath: join(userPluginsRoot(), "exa"),
      });
      openCommandSurface(shell, "plugins", deps);
      expect(runOverlayAction(shell, altKey("x"))).toBe(true);
      expect(shell.overlayKind).toBe("plugin_credentials");
      expect(shell.overlayItems[0]).toBe("Remove exa-search from disk");
      expect(calls.remove).toEqual([]);

      acceptOverlaySelection(shell);
      await Promise.resolve();
      expect(calls.remove).toEqual(["exa"]);
    });

    await withShell(async (shell) => {
      const { deps, calls } = pluginActionDeps({
        origin: "user",
        pluginPath: join(userPluginsRoot(), "exa"),
      });
      openCommandSurface(shell, "plugins", deps);
      expect(runOverlayAction(shell, altKey("x"))).toBe(true);
      moveOverlaySelection(shell, 1);
      acceptOverlaySelection(shell);
      await Promise.resolve();
      expect(calls.remove).toEqual([]);
    });

    await withShell(async (shell) => {
      const { deps, calls } = pluginActionDeps({
        origin: "user",
        pluginPath: join(userPluginsRoot(), "exa"),
      });
      openCommandSurface(shell, "plugins", deps);
      expect(runOverlayAction(shell, altKey("x"))).toBe(true);
      closeInsetOverlay(shell);
      await Promise.resolve();
      expect(calls.remove).toEqual([]);
      expect(shell.overlayKind).toBe("plugins");
      expect(shell.overlayItems.some((l) => l.includes("exa-search"))).toBe(true);
    });
  });

  test("project-origin Alt+X with cwd !== process.cwd() opens disk-confirm", async () => {
    const configCwd = join(tmpdir(), "cl-6887-not-process-cwd");
    expect(configCwd).not.toBe(process.cwd());
    await withShell(async (shell) => {
      const { deps, calls } = pluginActionDeps(
        {
          origin: "project",
          pluginPath: join(projectPluginsRoot(configCwd), "local"),
        },
        { cwd: configCwd },
      );
      openCommandSurface(shell, "plugins", deps);
      expect(runOverlayAction(shell, altKey("x"))).toBe(true);
      expect(shell.overlayKind).toBe("plugin_credentials");
      expect(shell.overlayItems[0]).toBe("Remove exa-search from disk");
      expect(calls.remove).toEqual([]);
    });
  });

  test("path Alt+X calls remove immediately", async () => {
    await withShell(async (shell) => {
      const { deps, calls } = pluginActionDeps({
        origin: "path",
        pluginPath: "/tmp/my-plugin",
      });
      openCommandSurface(shell, "plugins", deps);
      expect(runOverlayAction(shell, altKey("x"))).toBe(true);
      expect(shell.overlayKind).not.toBe("plugin_credentials");
      await Promise.resolve();
      expect(calls.remove).toEqual(["exa"]);
    });
  });

  test("path-origin under user plugins root Alt+X opens disk confirm", async () => {
    await withShell(async (shell) => {
      const { deps, calls } = pluginActionDeps({
        origin: "path",
        pluginPath: join(userPluginsRoot(), "exa"),
      });
      openCommandSurface(shell, "plugins", deps);
      expect(runOverlayAction(shell, altKey("x"))).toBe(true);
      expect(shell.overlayKind).toBe("plugin_credentials");
      expect(shell.overlayItems[0]).toBe("Remove exa-search from disk");
      expect(calls.remove).toEqual([]);
    });
  });

  test("bundled Alt+X calls remove immediately, no disk-confirm pane", async () => {
    await withShell(async (shell) => {
      const { deps, calls, notes } = pluginActionDeps({ origin: "repo" });
      openCommandSurface(shell, "plugins", deps);
      expect(runOverlayAction(shell, altKey("x"))).toBe(true);
      expect(shell.overlayKind).not.toBe("plugin_credentials");
      await Promise.resolve();
      expect(calls.remove).toEqual(["exa"]);
      expect(notes.some((n) => n.includes("cannot be uninstalled"))).toBe(true);
    });
  });

  test("Claude-unowned Alt+X immediately, no confirm", async () => {
    await withShell(async (shell) => {
      const { deps, calls } = pluginActionDeps({
        origin: "user",
        source: "claude",
        pluginPath: join(homedir(), ".claude", "plugins", "exa"),
      });
      openCommandSurface(shell, "plugins", deps);
      expect(runOverlayAction(shell, altKey("x"))).toBe(true);
      expect(shell.overlayKind).not.toBe("plugin_credentials");
      await Promise.resolve();
      expect(calls.remove).toEqual(["exa"]);
    });
  });

  test("empty plugin list Alt+A still opens add-path", async () => {
    await withShell(async (shell) => {
      const { deps, calls } = pluginActionDeps();
      const plugins = deps.plugins!;
      const empty: CommandSurfaceDeps = {
        ...deps,
        plugins: { ...plugins, list: () => [] },
      };
      openCommandSurface(shell, "plugins", empty);
      expect(runOverlayAction(shell, altKey("a"))).toBe(true);
      for (const ch of "/tmp/my-plugin") runOverlayAction(shell, charKey(ch));
      acceptOverlaySelection(shell);
      await Promise.resolve();
      expect(calls.addPath).toEqual(["/tmp/my-plugin"]);
    });
  });

  test("Alt+A on warnings/Close still opens add-path", async () => {
    await withShell(async (shell) => {
      const { deps, calls } = pluginActionDeps();
      const plugins = deps.plugins!;
      const withWarnings: CommandSurfaceDeps = {
        ...deps,
        plugins: {
          ...plugins,
          loadWarnings: () => [
            'agent a: skill "style" referenced but not found in skill search path',
          ],
        },
      };
      openCommandSurface(shell, "plugins", withWarnings);
      expect(runOverlayAction(shell, altKey("a"))).toBe(true);
      for (const ch of "/tmp/from-warnings") runOverlayAction(shell, charKey(ch));
      acceptOverlaySelection(shell);
      await Promise.resolve();
      expect(calls.addPath).toEqual(["/tmp/from-warnings"]);
    });
  });

  test("empty plugin list Alt+W still opens web chooser", async () => {
    await withShell(async (shell) => {
      const { deps, calls } = pluginActionDeps();
      const plugins = deps.plugins!;
      const empty: CommandSurfaceDeps = {
        ...deps,
        plugins: { ...plugins, list: () => [] },
      };
      openCommandSurface(shell, "plugins", empty);
      expect(runOverlayAction(shell, altKey("w"))).toBe(true);
      expect(shell.overlayKind).toBe("plugin_credentials");
      moveOverlaySelection(shell, 1);
      acceptOverlaySelection(shell);
      await Promise.resolve();
      expect(calls.setWebProvider).toEqual(["exa"]);
    });
  });

  test("Alt+X on warnings/Close is a no-op", async () => {
    await withShell(async (shell) => {
      const { deps, calls } = pluginActionDeps();
      const plugins = deps.plugins!;
      const withWarnings: CommandSurfaceDeps = {
        ...deps,
        plugins: {
          ...plugins,
          loadWarnings: () => [
            'agent a: skill "style" referenced but not found in skill search path',
          ],
        },
      };
      openCommandSurface(shell, "plugins", withWarnings);
      expect(runOverlayAction(shell, altKey("x"))).toBe(false);
      expect(calls.remove).toEqual([]);

      moveOverlaySelection(shell, 1);
      moveOverlaySelection(shell, 1);
      expect(runOverlayAction(shell, altKey("x"))).toBe(false);
      expect(calls.remove).toEqual([]);
    });
  });

  test("Alt+D on /plugins is a no-op", async () => {
    await withShell(async (shell) => {
      const { deps, calls } = pluginActionDeps();
      openCommandSurface(shell, "plugins", deps);
      expect(runOverlayAction(shell, altKey("d"))).toBe(false);
      expect(calls.remove).toEqual([]);
    });
  });

  test("confirm pane does not inherit Alt+X plugins hints", async () => {
    await withWiredShell(async (shell, h) => {
      const home = "/tmp/home";
      const cwd = "/tmp/cwd";
      const { deps } = pluginActionDeps(
        { origin: "user", pluginPath: join(userPluginsRoot(home), "exa") },
        { home, cwd },
      );
      openCommandSurface(shell, "plugins", deps);
      expect(runOverlayAction(shell, altKey("x"))).toBe(true);
      expect(shell.overlayKind).toBe("plugin_credentials");
      await h.renderOnce();
      const frame = h.captureCharFrame();
      expect(frame).toContain("Remove exa-search from disk");
      const title = frame.split("\n").find((l) => l.includes("remove plugin"));
      expect(title).toBeDefined();
      expect(title).not.toContain("Alt+X");
    });
  });

  test("description zone names disable-only for bundled and Claude plugins", () => {
    const { deps } = pluginActionDeps();
    const plugins = deps.plugins!;
    const bundled = pluginDescription(
      {
        id: "corbits-skills",
        name: "corbits-skills",
        enabled: true,
        credentials: [],
        credentialValues: {},
        origin: "repo",
      },
      plugins,
    );
    expect(bundled.impact).toContain("cannot be uninstalled");
    const claude = pluginDescription(
      {
        id: "exa",
        name: "exa-search",
        enabled: true,
        credentials: [],
        credentialValues: {},
        origin: "user",
        source: "claude",
        pluginPath: join(homedir(), ".claude", "plugins", "exa"),
      },
      plugins,
    );
    expect(claude.impact).toContain("without deleting ~/.claude");
    const warned = pluginDescription(
      {
        id: "agents",
        name: "agents",
        enabled: true,
        credentials: [],
        credentialValues: {},
        origin: "user",
        warnings: ['agent a: skill "style" referenced but not found in skill search path'],
      },
      plugins,
    );
    expect(warned.impact).toContain("skill");
    expect(warned.impact).not.toContain("Alt+X");
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
      expect(shell.overlayItems).toContain("Add MCP server — Alt+A");
    });
  });

  test("hides the add row while local MCP settings shadow global", async () => {
    await withShell((shell) => {
      openCommandSurface(shell, "mcp", {
        notify: () => {},
        mcp: {
          list: () => entries,
          openAuthURL: () => {},
          mcpServersSource: "local",
          addServer: async () => ({ ok: true, message: "should not run" }),
        },
      });
      expect(shell.overlayItems).not.toContain("Add MCP server — Alt+A");
      expect(shell.overlayItems.at(-1)).toBe("Close mcp");
      expect(runOverlayAction(shell, altKey("a"))).toBe(false);
    });
  });

  test("empty MCP list uses a placeholder distinct from close", async () => {
    await withShell((shell) => {
      openCommandSurface(shell, "mcp", {
        notify: () => {},
        mcp: { list: () => [], openAuthURL: () => {} },
      });
      expect(shell.overlayItems).toEqual([
        "No MCP servers configured",
        "Add MCP server — Alt+A",
        "Close mcp",
      ]);
    });
  });

  test("the visible add row opens the same add-server flow", async () => {
    await withShell((shell) => {
      openCommandSurface(shell, "mcp", {
        notify: () => {},
        mcp: { list: () => entries, openAuthURL: () => {} },
      });
      moveOverlaySelection(shell, entries.length);
      acceptOverlaySelection(shell);
      expect(shell.overlayItems).toEqual(["▏"]);
    });
  });

  test("dismissing and reopening releases the previous status subscription", async () => {
    await withShell((shell) => {
      const listeners = new Set<() => void>();
      const deps: CommandSurfaceDeps = {
        notify: () => {},
        mcp: {
          list: () => entries,
          openAuthURL: () => {},
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      };

      openCommandSurface(shell, "mcp", deps);
      expect(listeners.size).toBe(1);
      closeInsetOverlay(shell);
      expect(listeners.size).toBe(0);

      openCommandSurface(shell, "mcp", deps);
      expect(listeners.size).toBe(1);
      closeInsetOverlay(shell);
      expect(listeners.size).toBe(0);
    });
  });

  test("disposing an open MCP surface releases its status subscription exactly once", async () => {
    await withShell((shell) => {
      const listeners = new Set<() => void>();
      let unsubscribeCalls = 0;
      let listCalls = 0;
      const emitStatus = (): void => {
        for (const listener of [...listeners]) listener();
      };
      openCommandSurface(shell, "mcp", {
        notify: () => {},
        mcp: {
          list: () => {
            listCalls += 1;
            return entries;
          },
          openAuthURL: () => {},
          subscribe: (listener) => {
            listeners.add(listener);
            return () => {
              unsubscribeCalls += 1;
              listeners.delete(listener);
            };
          },
        },
      });

      expect(listeners.size).toBe(1);
      shell.dispose();
      expect(unsubscribeCalls).toBe(1);
      expect(listeners.size).toBe(0);
      const callsAfterDispose = listCalls;
      emitStatus();
      expect(listCalls).toBe(callsAfterDispose);
      expect(shell.overlayList).toBeNull();
      shell.dispose();
      expect(unsubscribeCalls).toBe(1);
    });
  });

  test("status refreshes the MCP surface while a palette is stacked over it", async () => {
    await withShell((shell) => {
      let liveEntries: readonly McpEntry[] = [{ name: "linear", state: "connecting" }];
      const listeners = new Set<() => void>();
      openCommandSurface(shell, "mcp", {
        notify: () => {},
        mcp: {
          list: () => liveEntries,
          openAuthURL: () => {},
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      });
      openPalette(shell, { catalog: [{ id: "help", label: "help" }] });

      liveEntries = [
        { name: "linear", state: "needs-auth", authURL: "https://linear.test/authorize" },
      ];
      for (const listener of [...listeners]) listener();
      expect(shell.overlayKind).toBe("palette");
      expect(listeners.size).toBe(1);

      closeInsetOverlay(shell);
      expect(shell.overlayKind).toBe("mcp");
      expect(shell.overlayItems[0]).toBe("linear — needs auth");
      expect(listeners.size).toBe(1);

      liveEntries = [{ name: "linear", state: "connected", toolCount: 3 }];
      for (const listener of [...listeners]) listener();
      expect(shell.overlayItems[0]).toBe("linear — connected · 3 tools");
      expect(listeners.size).toBe(1);
      closeInsetOverlay(shell);
      expect(listeners.size).toBe(0);
    });
  });

  test("an open surface refreshes a delayed OAuth transition and authorizes the live target", async () => {
    await withShell((shell) => {
      let liveEntries: readonly McpEntry[] = [
        { name: "exa", state: "connected", toolCount: 2 },
        { name: "linear", state: "connecting" },
      ];
      const listeners = new Set<() => void>();
      const opened: string[] = [];
      openCommandSurface(shell, "mcp", {
        notify: () => {},
        mcp: {
          list: () => liveEntries,
          openAuthURL: (url) => opened.push(url),
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      });
      expect(shell.overlayItems[1]).toBe("linear — connecting");
      moveOverlaySelection(shell, 1);

      liveEntries = [
        { name: "exa", state: "connected", toolCount: 2 },
        { name: "linear", state: "needs-auth", authURL: "https://linear.test/authorize" },
      ];
      for (const listener of [...listeners]) listener();

      expect(shell.overlayItems[1]).toBe("linear — needs auth");
      expect(shell.overlayList?.activeIndex).toBe(1);
      acceptOverlaySelection(shell);
      expect(opened).toEqual(["https://linear.test/authorize"]);
      expect(listeners.size).toBe(0);
    });
  });

  test("Enter on an unauthorized server opens the browser and copies the link", async () => {
    await withShell((shell) => {
      const opened: string[] = [];
      const retried: string[] = [];
      openCommandSurface(shell, "mcp", {
        notify: () => {},
        mcp: {
          list: () => entries,
          openAuthURL: (url) => opened.push(url),
          retryServer: async (name) => {
            retried.push(name);
            return { ok: true, message: "should not retry" };
          },
        },
      });
      moveOverlaySelection(shell, 1);
      acceptOverlaySelection(shell);
      expect(opened).toEqual(["https://notion.test/auth"]);
      expect(retried).toEqual([]);
      expect(shell.statusFlash).toContain("notion");
      // The echo would quote "notion — needs auth" back forever, moments
      // after the operator authorized it.
      expect(shell.streamLog.filter((r) => r.meta === "overlay")).toEqual([]);
    });
  });

  test("Enter on connecting and connected rows releases the status subscription", async () => {
    const nonActionEntries: readonly McpEntry[] = [
      { name: "connected", state: "connected", toolCount: 1 },
      { name: "connecting", state: "connecting" },
    ];

    for (const entry of nonActionEntries) {
      await withShell((shell) => {
        const listeners = new Set<() => void>();
        let unsubscribeCalls = 0;
        const opened: string[] = [];
        const retried: string[] = [];
        openCommandSurface(shell, "mcp", {
          notify: () => {},
          mcp: {
            list: () => [entry],
            openAuthURL: (url) => opened.push(url),
            retryServer: async (name) => {
              retried.push(name);
              return { ok: true, message: "should not retry" };
            },
            subscribe: (listener) => {
              listeners.add(listener);
              return () => {
                unsubscribeCalls += 1;
                listeners.delete(listener);
              };
            },
          },
        });

        expect(listeners.size).toBe(1);
        acceptOverlaySelection(shell);
        expect(opened).toEqual([]);
        expect(retried).toEqual([]);
        expect(unsubscribeCalls).toBe(1);
        expect(listeners.size).toBe(0);
      });
    }
  });

  test("Enter on a failed server retries connect once without adding again", async () => {
    await withShell(async (shell) => {
      const added: { name: string; url: string }[] = [];
      const retried: string[] = [];
      const opened: string[] = [];
      const notes: string[] = [];
      let liveEntries: readonly McpEntry[] = [
        { name: "sentry", state: "failed", error: "ECONNREFUSED" },
      ];
      openCommandSurface(shell, "mcp", {
        notify: (note) => notes.push(note),
        mcp: {
          list: () => liveEntries,
          openAuthURL: (url) => opened.push(url),
          addServer: async (name, url) => {
            added.push({ name, url });
            return { ok: true, message: "should not add" };
          },
          retryServer: async (name) => {
            retried.push(name);
            liveEntries = [{ name, state: "connecting" }];
            return { ok: true, message: `Retrying ${name}; connecting now.` };
          },
        },
      });
      acceptOverlaySelection(shell);
      await Promise.resolve();
      await Promise.resolve();

      expect(retried).toEqual(["sentry"]);
      expect(added).toEqual([]);
      expect(opened).toEqual([]);
      expect(notes).toEqual(["Retrying sentry; connecting now."]);
      expect(shell.overlayItems[0]).toBe("sentry — connecting");
    });
  });

  test("Enter on a failed row without retry still releases the status subscription", async () => {
    await withShell((shell) => {
      const listeners = new Set<() => void>();
      let unsubscribeCalls = 0;
      const added: { name: string; url: string }[] = [];
      openCommandSurface(shell, "mcp", {
        notify: () => {},
        mcp: {
          list: () => [{ name: "sentry", state: "failed", error: "offline" }],
          openAuthURL: () => {},
          addServer: async (name, url) => {
            added.push({ name, url });
            return { ok: true, message: "should not add" };
          },
          subscribe: (listener) => {
            listeners.add(listener);
            return () => {
              unsubscribeCalls += 1;
              listeners.delete(listener);
            };
          },
        },
      });

      expect(listeners.size).toBe(1);
      acceptOverlaySelection(shell);
      expect(added).toEqual([]);
      expect(unsubscribeCalls).toBe(1);
      expect(listeners.size).toBe(0);
    });
  });

  test("Alt+A of a failed name still persists through addServer", async () => {
    await withShell(async (shell) => {
      const added: { name: string; url: string }[] = [];
      const retried: string[] = [];
      const notes: string[] = [];
      openCommandSurface(shell, "mcp", {
        notify: (note) => notes.push(note),
        mcp: {
          list: () => [{ name: "sentry", state: "failed" as const, error: "offline" }],
          openAuthURL: () => {},
          addServer: async (name, url) => {
            added.push({ name, url });
            return {
              ok: false,
              message: `An MCP server named "${name}" already exists or is connecting.`,
            };
          },
          retryServer: async (name) => {
            retried.push(name);
            return { ok: true, message: "should not retry" };
          },
        },
      });

      expect(runOverlayAction(shell, altKey("a"))).toBe(true);
      for (const ch of "sentry") runOverlayAction(shell, charKey(ch));
      acceptOverlaySelection(shell);
      for (const ch of "https://sentry.test/mcp") runOverlayAction(shell, charKey(ch));
      acceptOverlaySelection(shell);
      await Promise.resolve();
      await Promise.resolve();

      expect(added).toEqual([{ name: "sentry", url: "https://sentry.test/mcp" }]);
      expect(retried).toEqual([]);
      expect(notes.at(-1)).toContain("already exists");
    });
  });

  test("Alt+A collects a name and absolute HTTP URL before adding", async () => {
    await withShell(async (shell) => {
      const added: { name: string; url: string }[] = [];
      let liveEntries: readonly McpEntry[] = entries;
      openCommandSurface(shell, "mcp", {
        notify: () => {},
        mcp: {
          list: () => liveEntries,
          openAuthURL: () => {},
          addServer: async (name, url) => {
            added.push({ name, url });
            liveEntries = [...liveEntries, { name, state: "connecting" }];
            return { ok: true, message: `Added ${name}.` };
          },
        },
      });

      expect(runOverlayAction(shell, altKey("a"))).toBe(true);
      for (const ch of "linear") runOverlayAction(shell, charKey(ch));
      acceptOverlaySelection(shell);
      for (const ch of "https://mcp.linear.app/mcp") runOverlayAction(shell, charKey(ch));
      acceptOverlaySelection(shell);
      await Promise.resolve();
      await Promise.resolve();

      expect(added).toEqual([{ name: "linear", url: "https://mcp.linear.app/mcp" }]);
      expect(shell.overlayItems).toContain("linear — connecting");
    });
  });

  test("wired shell preserves j and k in MCP names and URLs while ordinary lists still navigate", async () => {
    await withWiredShell(async (shell, harness) => {
      const added: { name: string; url: string }[] = [];
      openCommandSurface(shell, "mcp", {
        notify: () => {},
        mcp: {
          list: () => entries,
          openAuthURL: () => {},
          addServer: async (name, url) => {
            added.push({ name, url });
            return { ok: true, message: "added" };
          },
        },
      });
      runOverlayAction(shell, altKey("a"));

      for (const ch of "jira") harness.mockInput.pressKey(ch);
      expect(shell.overlayItems[0]).toBe("jira▏");
      harness.mockInput.pressKey("\r");
      for (const ch of "https://jira.test/mcp") harness.mockInput.pressKey(ch);
      expect(shell.overlayItems[0]).toBe("https://jira.test/mcp▏");
      harness.mockInput.pressKey("\r");
      await Promise.resolve();
      await Promise.resolve();
      expect(added).toEqual([{ name: "jira", url: "https://jira.test/mcp" }]);

      closeInsetOverlay(shell);
      openListOverlay(shell, { kind: "demo", items: ["first", "second"] });
      expect(shell.overlayList?.activeIndex).toBe(0);
      harness.mockInput.pressKey("j");
      expect(shell.overlayList?.activeIndex).toBe(1);
      harness.mockInput.pressKey("k");
      expect(shell.overlayList?.activeIndex).toBe(0);
    });
  });

  test("bracketed paste inserts an MCP URL into the owned text pane", async () => {
    await withWiredShell(async (shell, harness) => {
      const added: { name: string; url: string }[] = [];
      openCommandSurface(shell, "mcp", {
        notify: () => {},
        mcp: {
          list: () => entries,
          openAuthURL: () => {},
          addServer: async (name, url) => {
            added.push({ name, url });
            return { ok: true, message: "added" };
          },
        },
      });
      runOverlayAction(shell, altKey("a"));
      for (const ch of "jira") harness.mockInput.pressKey(ch);
      harness.mockInput.pressKey("\r");

      await harness.mockInput.pasteBracketedText("https://jira.test/mcp");
      await harness.renderOnce();
      expect(shell.overlayItems[0]).toBe("https://jira.test/mcp▏");
      harness.mockInput.pressKey("\r");
      await Promise.resolve();
      await Promise.resolve();
      expect(added).toEqual([{ name: "jira", url: "https://jira.test/mcp" }]);
    });
  });

  test("deferred add completion does not displace a newer gate overlay", async () => {
    await withShell(async (shell) => {
      let resolveAdd: ((result: { ok: boolean; message: string }) => void) | undefined;
      const deferredAdd = new Promise<{ ok: boolean; message: string }>((resolve) => {
        resolveAdd = resolve;
      });
      let gateCancellations = 0;
      openCommandSurface(shell, "mcp", {
        notify: () => {},
        mcp: {
          list: () => entries,
          openAuthURL: () => {},
          addServer: () => deferredAdd,
        },
      });

      expect(runOverlayAction(shell, altKey("a"))).toBe(true);
      for (const ch of "linear") runOverlayAction(shell, charKey(ch));
      acceptOverlaySelection(shell);
      for (const ch of "https://mcp.linear.app/mcp") runOverlayAction(shell, charKey(ch));
      acceptOverlaySelection(shell);

      openListOverlay(shell, {
        kind: "operator",
        title: "newer gate",
        items: ["Keep waiting"],
        onCancel: () => {
          gateCancellations += 1;
        },
      });
      resolveAdd?.({ ok: true, message: "Added linear." });
      await Promise.resolve();
      await Promise.resolve();

      expect(shell.overlayKind).toBe("operator");
      expect(shell.overlayItems).toEqual(["Keep waiting"]);
      expect(gateCancellations).toBe(0);
      closeInsetOverlay(shell);
      expect(gateCancellations).toBe(1);
    });
  });

  test("a resolved MCP add cannot continue into a disposed shell", async () => {
    await withShell(async (shell) => {
      let resolveAdd: ((result: { ok: boolean; message: string }) => void) | undefined;
      const deferredAdd = new Promise<{ ok: boolean; message: string }>((resolve) => {
        resolveAdd = resolve;
      });
      const notes: string[] = [];
      const listeners = new Set<() => void>();
      let subscribeCalls = 0;
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        openCommandSurface(shell, "mcp", {
          notify: (note) => {
            notes.push(note);
            throw new Error("disposed shell notified");
          },
          mcp: {
            list: () => entries,
            openAuthURL: () => {},
            subscribe: (listener) => {
              subscribeCalls += 1;
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            addServer: () => deferredAdd,
          },
        });
        runOverlayAction(shell, altKey("a"));
        for (const ch of "linear") runOverlayAction(shell, charKey(ch));
        acceptOverlaySelection(shell);
        for (const ch of "https://mcp.linear.app/mcp") runOverlayAction(shell, charKey(ch));
        acceptOverlaySelection(shell);

        shell.dispose();
        const overlayItemsAfterDispose = shell.overlayItems;
        resolveAdd?.({ ok: true, message: "Added linear." });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(notes).toEqual([]);
        expect(subscribeCalls).toBe(1);
        expect(listeners.size).toBe(0);
        expect(shell.overlayKind).toBeNull();
        expect(shell.overlayItems).toBe(overlayItemsAfterDispose);
        expect(shell.overlayHost.visible).toBe(false);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  });

  test("a rejected MCP add cannot continue into a disposed shell", async () => {
    await withShell(async (shell) => {
      let rejectAdd: ((reason: unknown) => void) | undefined;
      const deferredAdd = new Promise<{ ok: boolean; message: string }>((_resolve, reject) => {
        rejectAdd = reject;
      });
      const notes: string[] = [];
      const listeners = new Set<() => void>();
      let subscribeCalls = 0;
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        openCommandSurface(shell, "mcp", {
          notify: (note) => {
            notes.push(note);
            throw new Error("disposed shell notified");
          },
          mcp: {
            list: () => entries,
            openAuthURL: () => {},
            subscribe: (listener) => {
              subscribeCalls += 1;
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            addServer: () => deferredAdd,
          },
        });
        runOverlayAction(shell, altKey("a"));
        for (const ch of "linear") runOverlayAction(shell, charKey(ch));
        acceptOverlaySelection(shell);
        for (const ch of "https://mcp.linear.app/mcp") runOverlayAction(shell, charKey(ch));
        acceptOverlaySelection(shell);

        shell.dispose();
        const overlayItemsAfterDispose = shell.overlayItems;
        rejectAdd?.(new Error("connection failed"));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(notes).toEqual([]);
        expect(subscribeCalls).toBe(1);
        expect(listeners.size).toBe(0);
        expect(shell.overlayKind).toBeNull();
        expect(shell.overlayItems).toBe(overlayItemsAfterDispose);
        expect(shell.overlayHost.visible).toBe(false);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  });

  test("an invalid name stays focused with its value retained and can be corrected", async () => {
    await withShell(async (shell) => {
      const added: { name: string; url: string }[] = [];
      const notes: string[] = [];
      openCommandSurface(shell, "mcp", {
        notify: (note) => notes.push(note),
        mcp: {
          list: () => entries,
          openAuthURL: () => {},
          addServer: async (name, url) => {
            added.push({ name, url });
            return { ok: true, message: "added" };
          },
        },
      });
      runOverlayAction(shell, altKey("a"));
      for (const ch of "linear__admin") runOverlayAction(shell, charKey(ch));
      acceptOverlaySelection(shell);

      expect(added).toEqual([]);
      expect(notes.at(-1)).toContain("single underscores");
      expect(notes.at(-1)).toContain("__");
      expect(shell.overlayItems[0]).toBe("linear__admin▏");
      expect(focusOwner(shell.focus)).toBe("overlay");

      for (let i = 0; i < 7; i++) runOverlayAction(shell, key("backspace"));
      for (const ch of "-admin") runOverlayAction(shell, charKey(ch));
      acceptOverlaySelection(shell);
      for (const ch of "https://linear.test/mcp") runOverlayAction(shell, charKey(ch));
      acceptOverlaySelection(shell);
      await Promise.resolve();
      await Promise.resolve();
      expect(added).toEqual([{ name: "linear-admin", url: "https://linear.test/mcp" }]);
    });
  });

  test("an invalid URL stays focused with its value retained and can be corrected", async () => {
    await withShell(async (shell) => {
      const added: { name: string; url: string }[] = [];
      const notes: string[] = [];
      openCommandSurface(shell, "mcp", {
        notify: (note) => notes.push(note),
        mcp: {
          list: () => entries,
          openAuthURL: () => {},
          addServer: async (name, url) => {
            added.push({ name, url });
            return { ok: true, message: "added" };
          },
        },
      });
      runOverlayAction(shell, altKey("a"));
      for (const ch of "linear") runOverlayAction(shell, charKey(ch));
      acceptOverlaySelection(shell);
      const invalidURL = "relative/path";
      for (const ch of invalidURL) runOverlayAction(shell, charKey(ch));
      acceptOverlaySelection(shell);

      expect(added).toEqual([]);
      expect(notes.at(-1)).toContain("HTTP(S) URL");
      expect(shell.overlayItems[0]).toBe(`${invalidURL}▏`);
      expect(focusOwner(shell.focus)).toBe("overlay");

      for (const _character of invalidURL) runOverlayAction(shell, key("backspace"));
      for (const ch of "https://linear.test/mcp") runOverlayAction(shell, charKey(ch));
      acceptOverlaySelection(shell);
      await Promise.resolve();
      await Promise.resolve();
      expect(added).toEqual([{ name: "linear", url: "https://linear.test/mcp" }]);
    });
  });

  test("cancelling the add prompt does not add a server", async () => {
    await withShell((shell) => {
      const added: { name: string; url: string }[] = [];
      openCommandSurface(shell, "mcp", {
        notify: () => {},
        mcp: {
          list: () => entries,
          openAuthURL: () => {},
          addServer: async (name, url) => {
            added.push({ name, url });
            return { ok: true, message: "added" };
          },
        },
      });
      runOverlayAction(shell, altKey("a"));
      for (const ch of "linear") runOverlayAction(shell, charKey(ch));
      closeInsetOverlay(shell);

      expect(added).toEqual([]);
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
