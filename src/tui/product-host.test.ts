/**
 * Unit tests for product-host: pure helpers plus mount-level coverage of
 * `mountProductHost` using the headless harness and fakes.
 */
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type { PermissionRequest } from "../permission/types.js";
import { AGENTS_PANEL_LINGER_MS } from "./chrome-state.js";
import { createHarness } from "./harness.js";
import {
  acceptOverlaySelection,
  closeInsetOverlay,
  moveOverlaySelection,
  runOverlayAction,
} from "./shell.js";
import {
  mountProductHost,
  operatorResultFromSelection,
  permissionChoices,
  type ProductHostConfig,
} from "./product-host.js";
import { buildModelsFirstCatalog, modelOptionId } from "./model-catalog.js";

function makeFakeSessionPort(): {
  readonly sends: string[];
  readonly delivers: string[];
  readonly interrupts: number;
  readonly send: ProductHostConfig["send"];
  readonly interrupt: ProductHostConfig["interrupt"];
  readonly deliver: ProductHostConfig["deliver"];
} {
  const sends: string[] = [];
  const delivers: string[] = [];
  let interrupts = 0;
  return {
    sends,
    delivers,
    get interrupts() {
      return interrupts;
    },
    send: (text) => {
      sends.push(text);
    },
    interrupt: () => {
      interrupts += 1;
    },
    deliver: (text) => {
      delivers.push(text);
    },
  };
}

async function mountHeadless(overrides: Partial<ProductHostConfig> = {}): Promise<{
  host: Awaited<ReturnType<typeof mountProductHost>>;
  emitter: EventEmitter;
  destroyHarness: () => void;
  renderOnce: () => Promise<void>;
  captureCharFrame: () => string;
}> {
  const harness = await createHarness({ width: 80, height: 24 });
  const emitter = new EventEmitter();
  const port = makeFakeSessionPort();
  const host = await mountProductHost({
    title: "test-session",
    eventEmitter: emitter,
    send: port.send,
    interrupt: port.interrupt,
    deliver: port.deliver,
    createRenderer: async () => harness.renderer,
    ...overrides,
  });
  return {
    host,
    emitter,
    destroyHarness: harness.destroy,
    renderOnce: harness.renderOnce,
    captureCharFrame: harness.captureCharFrame,
  };
}

function makeRequest(scopes: PermissionRequest["scopes"] = []): PermissionRequest {
  return {
    tool: "bash",
    action: "run",
    subject: "ls -la",
    scopes,
  };
}

describe("permissionChoices", () => {
  test("always offers Reject + Accept once with stable itemIds", () => {
    const { items, itemIds, outcomes } = permissionChoices(makeRequest());
    expect(items).toEqual(["Reject", "Accept once"]);
    expect(itemIds).toEqual(["__deny__", "__once__"]);
    expect(outcomes).toEqual([{ allow: false }, { allow: true }]);
    expect(items).toHaveLength(itemIds.length);
    expect(items).toHaveLength(outcomes.length);
  });

  test("appends scopes with hint labels and persist when pattern set", () => {
    const scope = {
      id: "session-bash",
      label: "Allow bash for session",
      pattern: "bash:*",
      hint: "session",
      grant: "session" as const,
    };
    const { items, itemIds, outcomes } = permissionChoices(makeRequest([scope]));
    expect(items[2]).toBe("Allow bash for session (session)");
    expect(itemIds[2]).toBe("session-bash");
    expect(outcomes[2]).toEqual({ allow: true, persist: scope });
  });

  test("scope with null pattern allows without persist", () => {
    const scope = {
      id: "once-path",
      label: "This path only",
      pattern: null,
    };
    const { outcomes, itemIds } = permissionChoices(makeRequest([scope]));
    expect(itemIds[2]).toBe("once-path");
    expect(outcomes[2]).toEqual({ allow: true });
    expect("persist" in (outcomes[2] ?? {})).toBe(false);
  });

  test("selection index maps to correct outcome (deny / once / scope)", () => {
    const scope = {
      id: "proj",
      label: "Project",
      pattern: "read:*",
    };
    const { outcomes } = permissionChoices(makeRequest([scope]));
    expect(outcomes[0]).toEqual({ allow: false });
    expect(outcomes[1]).toEqual({ allow: true });
    expect(outcomes[2]).toEqual({ allow: true, persist: scope });
    // out-of-range fallback used by host
    expect(outcomes[99] ?? { allow: false }).toEqual({ allow: false });
  });
});

describe("operatorResultFromSelection", () => {
  test("valid index → { kind: option, index }", () => {
    expect(operatorResultFromSelection({ index: 0 }, 3)).toEqual({
      kind: "option",
      index: 0,
    });
    expect(operatorResultFromSelection({ index: 2 }, 3)).toEqual({
      kind: "option",
      index: 2,
    });
  });

  test("out-of-range / negative → { kind: cancel }", () => {
    expect(operatorResultFromSelection({ index: -1 }, 2)).toEqual({
      kind: "cancel",
    });
    expect(operatorResultFromSelection({ index: 2 }, 2)).toEqual({
      kind: "cancel",
    });
    expect(operatorResultFromSelection({ index: 0 }, 0)).toEqual({
      kind: "cancel",
    });
  });
});

describe("mountProductHost", () => {
  test("stream events emitted on the event emitter paint rows into the shell", async () => {
    const { host, emitter } = await mountHeadless();
    try {
      emitter.emit("event", { type: "user", text: "hello there" });
      emitter.emit("event", { type: "assistant", text: "hi back" });
      expect(host.shell.streamLog).toEqual([
        { role: "user", text: "hello there" },
        { role: "assistant", text: "hi back" },
      ]);
    } finally {
      host.dispose();
    }
  });

  test("history.hydrate replays blocks as stream rows", async () => {
    const { host, emitter } = await mountHeadless();
    try {
      emitter.emit("history.hydrate", [
        { type: "user", content: "past prompt" },
        { type: "text", content: "past reply" },
        { type: "unknown" },
      ]);
      expect(host.shell.streamLog).toEqual([
        { role: "user", text: "past prompt" },
        { role: "assistant", text: "past reply" },
      ]);
    } finally {
      host.dispose();
    }
  });

  test("session.title updates the shell header", async () => {
    const { host, emitter } = await mountHeadless();
    try {
      expect(host.shell.baseTitle).toBe("test-session");
      emitter.emit("session.title", "renamed session");
      expect(host.shell.baseTitle).toBe("renamed session");
    } finally {
      host.dispose();
    }
  });

  test("session.clear wipes the painted transcript (CL-5612)", async () => {
    const { host, emitter } = await mountHeadless();
    try {
      emitter.emit("event", { type: "user", text: "old prompt" });
      emitter.emit("event", { type: "assistant", text: "old reply" });
      expect(host.shell.streamLog.length).toBe(2);

      emitter.emit("session.clear");
      expect(host.shell.streamLog).toEqual([]);
      expect(host.shell.streamLogBase).toBe(0);
      expect(host.shell.lineCount).toBe(0);

      // Subsequent turns land on the empty transcript.
      emitter.emit("event", { type: "user", text: "fresh prompt" });
      expect(host.shell.streamLog).toEqual([{ role: "user", text: "fresh prompt" }]);
    } finally {
      host.dispose();
    }
  });

  test("session.clear drops queued steers and idles the run (CL-7268)", async () => {
    const { host, emitter } = await mountHeadless();
    try {
      host.bridge.handle({ type: "run", state: "busy" });
      host.bridge.submit("old steer", "steer");
      expect(host.shell.session.run).toBe("busy");
      expect(host.shell.session.items.length).toBe(1);

      emitter.emit("event", { type: "user", text: "old prompt" });
      emitter.emit("session.clear");

      expect(host.shell.streamLog).toEqual([]);
      expect(host.shell.session.items).toEqual([]);
      expect(host.shell.session.run).toBe("idle");
    } finally {
      host.dispose();
    }
  });

  test("permission.gate opens the overlay and resolves through the emitter's resolve callback", async () => {
    const { host, emitter } = await mountHeadless();
    try {
      let resolved: unknown;
      const request: PermissionRequest = {
        tool: "bash",
        action: "run",
        subject: "ls",
        scopes: [],
      };
      emitter.emit("permission.gate", {
        request,
        resolve: (outcome: unknown) => {
          resolved = outcome;
        },
      });
      expect(host.shell.overlayKind).toBe("permissions");
      expect(host.shell.overlayItems).toEqual(["Reject", "Accept once"]);

      acceptOverlaySelection(host.shell);
      expect(resolved).toEqual({ allow: false });
    } finally {
      host.dispose();
    }
  });

  test("operator.gate opens the overlay and resolves through the emitter's resolve callback", async () => {
    const { host, emitter } = await mountHeadless();
    try {
      emitter.emit("operator.gate", {
        question: "Proceed?",
        options: ["Cancel", "Continue"],
        resolve: (_result: unknown) => {},
      });
      expect(host.shell.overlayKind).toBe("operator");
      expect(host.shell.overlayItems).toEqual(["Cancel", "Continue"]);
    } finally {
      host.dispose();
    }
  });

  test("dispose() detaches emitter listeners and resolves waitUntilExit", async () => {
    const { host, emitter } = await mountHeadless();

    expect(emitter.listenerCount("event")).toBe(1);
    expect(emitter.listenerCount("history.hydrate")).toBe(1);
    expect(emitter.listenerCount("session.title")).toBe(1);
    expect(emitter.listenerCount("session.clear")).toBe(1);
    expect(emitter.listenerCount("permission.gate")).toBe(1);
    expect(emitter.listenerCount("operator.gate")).toBe(1);

    const exited = host.waitUntilExit();
    host.dispose();
    await exited;

    expect(emitter.listenerCount("event")).toBe(0);
    expect(emitter.listenerCount("history.hydrate")).toBe(0);
    expect(emitter.listenerCount("session.title")).toBe(0);
    expect(emitter.listenerCount("session.clear")).toBe(0);
    expect(emitter.listenerCount("permission.gate")).toBe(0);
    expect(emitter.listenerCount("operator.gate")).toBe(0);
  });

  test("dispose() is idempotent and events after dispose are ignored", async () => {
    const { host, emitter } = await mountHeadless();
    host.dispose();
    expect(() => host.dispose()).not.toThrow();

    // Listeners were removed by dispose; emitting is a no-op, not a throw.
    expect(() => emitter.emit("event", { type: "user", text: "late" })).not.toThrow();
    expect(host.shell.streamLog).toEqual([]);
  });

  test("setChrome with running agents paints an agents panel clock", async () => {
    const now = Date.now();
    const { host, renderOnce, captureCharFrame } = await mountHeadless({
      chrome: {
        agents: [
          {
            agentId: "explorer",
            currentToolStartedAt: null,
            description: "map callers",
            status: "running",
            startedAt: now - 59_000,
            lastActivityAt: now,
          },
        ],
      },
    });
    try {
      await renderOnce();
      // Live agents strip above the prompt — sticky poll keeps the clock fresh.
      expect(captureCharFrame()).toContain("0:59");
      expect(captureCharFrame()).toContain("map callers");

      await new Promise((r) => setTimeout(r, 1_100));
      await renderOnce();
      expect(captureCharFrame()).toMatch(/1:0\d/);
      expect(captureCharFrame()).toContain("map callers");
    } finally {
      host.dispose();
    }
  });

  test("sticky ticks clear the agents zone after linger without setChrome", async () => {
    const now = Date.now();
    const { host, renderOnce, captureCharFrame, destroyHarness } = await mountHeadless({
      chrome: {
        agents: [
          {
            agentId: "explorer",
            currentToolStartedAt: null,
            description: "map callers",
            status: "done",
            startedAt: now - 10_000,
            lastActivityAt: now,
            finishedAt: now,
          },
        ],
      },
    });
    try {
      await renderOnce();
      expect(host.shell.layout.heights.agents).toBeGreaterThan(0);
      expect(captureCharFrame()).toContain("map callers");

      // Only sticky poll may clear — no setChrome. Wait past linger + one tick.
      await new Promise((r) => setTimeout(r, AGENTS_PANEL_LINGER_MS + 500));
      await renderOnce();
      expect(host.shell.layout.heights.agents).toBe(0);
      expect(captureCharFrame()).not.toContain("map callers");
    } finally {
      host.dispose();
      destroyHarness();
    }
  });
});

describe("flat type-to-filter model picker", () => {
  // Several providers, one (codex) with three accounts, plus a favorite so the
  // top of the flat list has a reachable pick without typing.
  const providers = {
    "codex/abk-labs": { models: ["gpt-5.5", "gpt-5.6-sol"] },
    "codex/dirtroad": { models: ["gpt-5.5", "gpt-5.6-sol"] },
    "codex/fleur": { models: ["gpt-5.5", "gpt-5.6-sol"] },
    "xai/thegreataxios": { models: ["grok-4.5"] },
    "Z.AI": { models: ["glm-5", "glm-5-turbo", "glm-5.2"] },
  };

  async function mountPicker(overrides: Partial<ProductHostConfig> = {}) {
    // One row taller than the usual fixture: on the landing screen (no
    // session content yet, which this fixture never sends) the version badge
    // reserves the terminal's last row, and this picker's row list needs
    // every row of the 24-row case to fit every provider.
    const harness = await createHarness({ width: 80, height: 25 });
    const port = makeFakeSessionPort();
    const catalog = buildModelsFirstCatalog({
      providers,
      favorites: [{ provider: "codex/abk-labs", model: "gpt-5.5" }],
    });
    const selected: string[] = [];
    const host = await mountProductHost({
      title: "test-session",
      eventEmitter: new EventEmitter(),
      send: port.send,
      interrupt: port.interrupt,
      deliver: port.deliver,
      createRenderer: async () => harness.renderer,
      models: catalog,
      onModelSelect: (id) => selected.push(id),
      ...overrides,
    });
    return { harness, host, selected };
  }

  test("opens a flat provider/model list (no nested provider drill)", async () => {
    const { harness, host } = await mountPicker();
    try {
      host.openModels?.();
      await harness.renderOnce();
      const frame = harness.captureCharFrame();
      const items = host.shell.overlayItems;
      // Flat list: every model is a leaf row at the top level (assert the
      // data, not the scrolled viewport — short harness heights clip later rows).
      expect(items.some((label) => label.includes("gpt-5.5"))).toBe(true);
      expect(items.some((label) => label.includes("grok-4.5"))).toBe(true);
      expect(items.some((label) => label.includes("codex/abk-labs"))).toBe(true);
      expect(items.some((label) => label.includes("xai/thegreataxios"))).toBe(true);
      // No provider-group-only rows (those were `providerGroup:` ids with no model).
      expect(items.every((label) => label.includes(" * [") || label.startsWith("("))).toBe(true);
      // Filter row is present so the list can narrow without another pane.
      expect(frame).toContain(">");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("typing narrows the flat list; selecting a model applies the pick", async () => {
    const { harness, host, selected } = await mountPicker();
    try {
      host.openModels?.();
      await harness.renderOnce();

      // Type "grok" into the filter row (printable keys claimed by type-to-filter).
      for (const ch of "grok") {
        harness.pressKey(ch);
      }
      await harness.renderOnce();

      const items = host.shell.overlayItems;
      expect(items.some((label) => label.includes("grok-4.5"))).toBe(true);
      expect(items.every((label) => label.includes("grok") || label === "(no matches)")).toBe(true);

      const grokIndex = items.findIndex((label) => label.includes("grok-4.5"));
      expect(grokIndex).toBeGreaterThanOrEqual(0);
      moveOverlaySelection(host.shell, grokIndex);
      acceptOverlaySelection(host.shell);
      expect(selected).toEqual(["xai/thegreataxios:grok-4.5"]);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("selecting a model applies the pick without descending", async () => {
    const { harness, host, selected } = await mountPicker();
    try {
      host.openModels?.();
      await harness.renderOnce();
      const items = host.shell.overlayItems;
      const grokIndex = items.findIndex((label) => label.includes("grok-4.5"));
      expect(grokIndex).toBeGreaterThanOrEqual(0);
      moveOverlaySelection(host.shell, grokIndex);
      acceptOverlaySelection(host.shell);
      expect(selected).toEqual(["xai/thegreataxios:grok-4.5"]);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test('the current model\'s row reads "(current)" at a glance', async () => {
    const harness = await createHarness({ width: 80, height: 24 });
    const port = makeFakeSessionPort();
    const catalog = buildModelsFirstCatalog({
      providers,
      recent: [{ provider: "xai/thegreataxios", model: "grok-4.5" }],
    });
    const host = await mountProductHost({
      title: "test-session",
      eventEmitter: new EventEmitter(),
      send: port.send,
      interrupt: port.interrupt,
      deliver: port.deliver,
      createRenderer: async () => harness.renderer,
      models: catalog,
      activeModelId: () => modelOptionId("xai/thegreataxios", "grok-4.5"),
      onModelSelect: () => {},
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      const frame = harness.captureCharFrame();
      expect(frame).toContain("grok-4.5 * [xai/thegreataxios] (current)");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("stale recents pointing at a different model do not steal the (current) marker", async () => {
    // Recents still name the model a *previous* session last switched to;
    // this session has run codex/abk-labs / gpt-5.5 all along without ever
    // touching the picker. The live model, not the recents list, decides
    // which row reads "(current)".
    const harness = await createHarness({ width: 80, height: 24 });
    const port = makeFakeSessionPort();
    const catalog = buildModelsFirstCatalog({
      providers,
      recent: [{ provider: "xai/thegreataxios", model: "grok-4.5" }],
    });
    const host = await mountProductHost({
      title: "test-session",
      eventEmitter: new EventEmitter(),
      send: port.send,
      interrupt: port.interrupt,
      deliver: port.deliver,
      createRenderer: async () => harness.renderer,
      models: catalog,
      activeModelId: () => modelOptionId("codex/abk-labs", "gpt-5.5"),
      onModelSelect: () => {},
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      const frame = harness.captureCharFrame();
      expect(frame).not.toContain("grok-4.5 * [xai/thegreataxios] (current)");
      expect(frame).toContain("gpt-5.5 * [codex/abk-labs] (current)");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("fits and scrolls within a short terminal instead of overflowing it", async () => {
    const port = makeFakeSessionPort();
    const harness = await createHarness({ width: 80, height: 10 });
    try {
      const catalog = buildModelsFirstCatalog({ providers });
      const host = await mountProductHost({
        title: "test-session",
        eventEmitter: new EventEmitter(),
        send: port.send,
        interrupt: port.interrupt,
        deliver: port.deliver,
        createRenderer: async () => harness.renderer,
        models: catalog,
        onModelSelect: () => {},
      });
      try {
        host.openModels?.();
        await harness.renderOnce();
        const frame = harness.captureCharFrame();
        // Five provider rows do not all fit a 10-row terminal alongside the
        // overlay chrome; the picker renders without throwing and the frame
        // stays within the terminal's own line count.
        expect(frame.replace(/\n$/, "").split("\n").length).toBeLessThanOrEqual(10);
        expect(host.shell.overlayList).not.toBeNull();
      } finally {
        host.dispose();
      }
    } finally {
      harness.destroy();
    }
  });

  test("Enter on a no-matches filter does not apply a model", async () => {
    const { harness, host, selected } = await mountPicker();
    try {
      host.openModels?.();
      await harness.renderOnce();
      for (const ch of "zzzz-no-such-model") {
        harness.pressKey(ch);
      }
      await harness.renderOnce();
      expect(host.shell.overlayItems).toEqual(["(no matches)"]);
      acceptOverlaySelection(host.shell);
      expect(selected).toEqual([]);
      expect(host.shell.overlayList).not.toBeNull();
      expect(host.shell.overlayItems).toEqual(["(no matches)"]);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("filtered accept uses the filtered row id, not the unfiltered catalog index", async () => {
    // Catalog order puts favorites/recents first; after filtering to "grok",
    // index 0 is the grok row — accepting must still apply the grok id, never
    // the catalog's index-0 favorite.
    const { harness, host, selected } = await mountPicker();
    try {
      host.openModels?.();
      await harness.renderOnce();
      for (const ch of "grok") {
        harness.pressKey(ch);
      }
      await harness.renderOnce();
      // Accept whatever is focused after filter (should be the sole match).
      acceptOverlaySelection(host.shell);
      expect(selected).toEqual(["xai/thegreataxios:grok-4.5"]);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("Alt+F on the no-matches sentinel does not toggle a favorite", async () => {
    const favorites: string[] = [];
    const { harness, host } = await mountPicker({
      onFavoriteToggle: (id) => favorites.push(id),
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      for (const ch of "zzzz-no-such-model") {
        harness.pressKey(ch);
      }
      await harness.renderOnce();
      expect(host.shell.overlayItems).toEqual(["(no matches)"]);
      harness.pressKey("f", { meta: true });
      await harness.renderOnce();
      expect(favorites).toEqual([]);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  const altD = { name: "d", ctrl: false, meta: false, option: true } as KeyEvent;

  test("Alt+D on a focused row calls onSetDefault and leaves the picker open", async () => {
    const defaults: string[] = [];
    const { harness, host } = await mountPicker({
      onSetDefault: (id) => defaults.push(id),
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      expect(runOverlayAction(host.shell, altD)).toBe(true);
      expect(defaults).toEqual(["codex/abk-labs:gpt-5.5"]);
      expect(host.shell.overlayKind).toBe("model_picker");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("Alt+D on the no-matches sentinel does not set a default", async () => {
    const defaults: string[] = [];
    const { harness, host } = await mountPicker({
      onSetDefault: (id) => defaults.push(id),
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      for (const ch of "zzzz-no-such-model") {
        harness.pressKey(ch);
      }
      await harness.renderOnce();
      expect(host.shell.overlayItems).toEqual(["(no matches)"]);
      expect(runOverlayAction(host.shell, altD)).toBe(false);
      expect(defaults).toEqual([]);
      expect(host.shell.overlayKind).toBe("model_picker");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("the model picker footer advertises Alt+D when onSetDefault is wired", async () => {
    const { harness, host } = await mountPicker({
      onSetDefault: () => {},
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      expect(harness.captureCharFrame()).toContain("Alt+D");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("the model picker footer does not advertise Alt+D when onSetDefault is omitted", async () => {
    const { harness, host } = await mountPicker();
    try {
      host.openModels?.();
      await harness.renderOnce();
      expect(harness.captureCharFrame()).not.toContain("Alt+D");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  const altA = { name: "a", ctrl: false, meta: false, option: true } as KeyEvent;

  test("the model picker footer advertises Alt+A", async () => {
    const { harness, host } = await mountPicker({
      // The hint requires the full wiring — choices AND the connect handler —
      // because that is exactly when the key actually works.
      onConnectProvider: () => {},
      addProviderChoices: () => [{ id: "codex", label: "Codex", hint: "", accountCount: 0 }],
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      expect(harness.captureCharFrame()).toContain("Alt+A");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("Alt+A opens the add-provider selector listing every provider kind and its account count", async () => {
    const { harness, host } = await mountPicker({
      onConnectProvider: () => {},
      addProviderChoices: () => [
        { id: "codex", label: "Codex", hint: "ChatGPT subscription", accountCount: 2 },
        { id: "openai", label: "OpenAI", hint: "", accountCount: 0 },
        { id: "custom", label: "Custom", hint: "any OpenAI-compatible endpoint", accountCount: 0 },
      ],
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      expect(runOverlayAction(host.shell, altA)).toBe(true);
      await harness.renderOnce();
      expect(host.shell.overlayKind).toBe("add_provider");
      expect(host.shell.overlayItems).toEqual([
        "Codex — 2 accounts",
        "OpenAI — 0 accounts",
        "Custom — 0 accounts",
      ]);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("Enter on a Custom add-provider row runs the connect flow for custom", async () => {
    const connected: string[] = [];
    const { harness, host } = await mountPicker({
      onConnectProvider: (name) => connected.push(name),
      addProviderChoices: () => [
        { id: "openai", label: "OpenAI", hint: "", accountCount: 0 },
        { id: "custom", label: "Custom", hint: "", accountCount: 0 },
      ],
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      runOverlayAction(host.shell, altA);
      await harness.renderOnce();
      // Move to the Custom row (second item) and accept.
      moveOverlaySelection(host.shell, 1);
      acceptOverlaySelection(host.shell);
      expect(connected).toEqual(["custom"]);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("Esc from the add-provider selector returns to the model list", async () => {
    const { harness, host } = await mountPicker({
      onConnectProvider: () => {},
      addProviderChoices: () => [{ id: "codex", label: "Codex", hint: "", accountCount: 1 }],
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      const modelItems = host.shell.overlayItems;
      runOverlayAction(host.shell, altA);
      await harness.renderOnce();
      expect(host.shell.overlayKind).toBe("add_provider");
      closeInsetOverlay(host.shell);
      await harness.renderOnce();
      expect(host.shell.overlayKind).toBe("model_picker");
      expect(host.shell.overlayItems).toEqual(modelItems);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("Enter on an add-provider row runs the connect flow for that provider", async () => {
    const connected: string[] = [];
    const { harness, host } = await mountPicker({
      onConnectProvider: (name) => connected.push(name),
      addProviderChoices: () => [{ id: "codex", label: "Codex", hint: "", accountCount: 0 }],
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      runOverlayAction(host.shell, altA);
      await harness.renderOnce();
      acceptOverlaySelection(host.shell);
      expect(connected).toEqual(["codex"]);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("without addProviderChoices, Alt+A is not claimed", async () => {
    const { harness, host } = await mountPicker();
    try {
      host.openModels?.();
      await harness.renderOnce();
      expect(runOverlayAction(host.shell, altA)).toBe(false);
      expect(host.shell.overlayKind).toBe("model_picker");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("without addProviderChoices, the footer never advertises Alt+A", async () => {
    // The hint and the key claim must move together: a host that omits
    // addProviderChoices gets neither, so the footer never names a dead key.
    const { harness, host } = await mountPicker();
    try {
      host.openModels?.();
      await harness.renderOnce();
      expect(harness.captureCharFrame()).not.toContain("Alt+A");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("openModels(focusId) preselects the given row instead of the top of the list", async () => {
    const { harness, host } = await mountPicker();
    try {
      host.openModels?.("codex/abk-labs:gpt-5.6-sol");
      await harness.renderOnce();
      const idx = host.shell.overlayItems.findIndex((label) => label.includes("gpt-5.6-sol"));
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(host.shell.overlayList?.activeIndex).toBe(idx);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });
});

describe("mount failure", () => {
  test("destroys the renderer when gate wiring throws", async () => {
    const harness = await createHarness({ width: 80, height: 24 });
    let destroyed = 0;
    const realDestroy = harness.renderer.destroy.bind(harness.renderer);
    harness.renderer.destroy = () => {
      destroyed += 1;
      realDestroy();
    };

    // Gate wiring is the first thing to touch the emitter after the renderer
    // owns the alternate screen; a throw there once leaked the renderer.
    const emitter = new EventEmitter();
    const realOn = emitter.on.bind(emitter);
    emitter.on = ((event: string, listener: (...args: unknown[]) => void) => {
      if (event === "permission.gate") throw new Error("gate wiring failed");
      return realOn(event, listener);
    }) as typeof emitter.on;

    const port = makeFakeSessionPort();
    await expect(
      mountProductHost({
        title: "crash-on-mount",
        eventEmitter: emitter,
        send: port.send,
        interrupt: port.interrupt,
        deliver: port.deliver,
        createRenderer: async () => harness.renderer,
      }),
    ).rejects.toThrow("gate wiring failed");
    expect(destroyed).toBe(1);
  });
});
