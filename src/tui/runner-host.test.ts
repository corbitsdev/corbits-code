import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";

import type { KeyEvent } from "@opentui/core";

import type { CostSummary } from "../cost/cost-summary.js";
import type { SubAgentSession } from "../subagent/session-store.js";
import { createHarness } from "./harness.js";
import { acceptOverlaySelection, closeInsetOverlay, runOverlayAction } from "./shell.js";
import {
  mountRunnerHost,
  observeSessionFromSubAgents,
  rowFromTranscriptEntry,
} from "./runner-host.js";

/** The bottom rule holds StyledText; join its chunks for assertions. */
function ruleOf(rule: { content: unknown }): string {
  const content = rule.content;
  if (typeof content === "string") return content;
  const { chunks } = content as { chunks?: readonly { text?: string }[] };
  return (chunks ?? []).map((c) => c.text ?? "").join("");
}

function fakeCostSummary(): CostSummary {
  return {
    modelId: "opus",
    pricingCache: null,
    totalCost: 0.42,
    formattedCost: "$0.42",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    contextTokens: 1000,
    contextIsEstimate: false,
    costHiddenReason: null,
    contextWindow: 10000,
    contextPercentUsed: 10,
  };
}

function session(over: Partial<SubAgentSession>): SubAgentSession {
  return {
    id: "s1",
    description: "explore callers",
    agentId: "explorer",
    brief: "",
    status: "running",
    toolNames: [],
    currentToolName: null,
    currentToolPreview: null,
    currentToolStartedAt: null,
    outstandingTools: [],
    entries: [],
    startedAt: 0,
    lastActivityAt: 0,
    lifecycleStatus: "running",
    ...over,
  };
}

describe("rowFromTranscriptEntry", () => {
  test("maps each entry kind onto a stream row", () => {
    expect(rowFromTranscriptEntry({ kind: "text", content: "hi" })).toEqual({
      role: "assistant",
      text: "hi",
    });
    expect(rowFromTranscriptEntry({ kind: "thinking", content: "hm" })).toEqual({
      role: "system",
      text: "hm",
      meta: "thinking",
    });
    expect(
      rowFromTranscriptEntry({ kind: "tool", callId: "c", name: "grep", arguments: "{}" }),
    ).toEqual({
      role: "tool",
      text: "{}",
      meta: "grep",
      verb: "Grep",
      // Empty summary is intentional: without it the paint layer falls through
      // to raw argument JSON (CL-5762). Verb alone names the call.
      summary: "",
      pending: true,
      callKey: "grep Grep ",
      callId: "c",
    });
    expect(
      rowFromTranscriptEntry({
        kind: "tool_result",
        callId: "c",
        name: "grep",
        content: "boom",
        isError: true,
      }),
    ).toEqual({ role: "tool", text: "boom", meta: "grep", failed: true, callId: "c" });
    expect(rowFromTranscriptEntry({ kind: "report", content: "done" })).toEqual({
      role: "assistant",
      text: "done",
      meta: "report",
    });
  });
});

describe("observeSessionFromSubAgents", () => {
  test("returns null with no sessions", () => {
    expect(observeSessionFromSubAgents([])).toBeNull();
  });

  test("prefers the newest running session", () => {
    const observed = observeSessionFromSubAgents([
      session({ id: "old", status: "running" }),
      session({ id: "newest", status: "running", agentId: "builder" }),
      session({ id: "finished", status: "done" }),
    ]);
    expect(observed?.sessionId).toBe("newest");
    expect(observed?.agentId).toBe("builder");
  });

  test("falls back to the most recent session when none run", () => {
    const observed = observeSessionFromSubAgents([
      session({ id: "a", status: "done" }),
      session({
        id: "b",
        status: "failed",
        entries: [{ kind: "text", content: "partial" }],
      }),
    ]);
    expect(observed?.sessionId).toBe("b");
    expect(observed?.lines).toEqual([{ role: "assistant", text: "partial" }]);
  });
});

describe("mountRunnerHost chrome wiring", () => {
  // CL-5731: subscribeChrome must stay wired end-to-end. formatChromeZones
  // now parks both chrome strips (always null), so a tasks push must not
  // paint the checklist — this test asserts the notify path still runs and
  // leaves the task panel empty (rebuild later; live work is ● Task rows).
  test("a live chrome push (subscribeChrome notify) does not auto-paint the task panel", async () => {
    const harness = await createHarness({ width: 80, height: 24 });
    let liveTasks: readonly { title: string; status: "todo" | "doing" | "done" | "cancelled" }[] =
      [];
    let notify: (() => void) | undefined;
    const host = await mountRunnerHost({
      title: "test",
      eventEmitter: new EventEmitter(),
      send: () => {},
      interrupt: () => {},
      providers: {},
      onModelSelect: () => {},
      commands: [],
      onCommand: () => {},
      chrome: () => ({ tasks: liveTasks, agents: [] }),
      subscribeChrome: (n) => {
        notify = n;
        return () => {
          notify = undefined;
        };
      },
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
    });
    try {
      expect(host.shell.taskBox.visible).toBe(false);
      expect(notify).toBeDefined();

      // Mirrors createChatDirector's onTasksChange: live source changes, then
      // the runner notifies the host. formatChromeZones parks the checklist.
      liveTasks = [{ title: "wire task panel", status: "doing" }];
      notify?.();

      expect(host.shell.taskBox.visible).toBe(false);
      await harness.renderOnce();
      const frame = harness.captureCharFrame();
      expect(frame).not.toContain("wire task panel");
      // Notify callback stayed registered — subscribe path ran without error.
      expect(notify).toBeDefined();
    } finally {
      host.dispose();
      harness.destroy();
    }
  });
});

describe("mountRunnerHost command surfaces", () => {
  test("routes settings and models, and reports surfaces with no data source", async () => {
    const harness = await createHarness({ width: 80, height: 24 });
    const host = await mountRunnerHost({
      title: "test",
      eventEmitter: new EventEmitter(),
      send: () => {},
      interrupt: () => {},
      providers: {},
      onModelSelect: () => {},
      commands: [],
      onCommand: () => {},
      chrome: () => ({ agents: [] }),
      subscribeChrome: () => () => {},
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
      surfaces: {
        settings: {
          read: () => ({
            compactionMode: "llm",
            waitForApproval: true,
            telemetryEnabled: false,
            showPromptCost: false,
          }),
          setCompactionMode: () => {},
          setWaitForApproval: () => {},
          setTelemetryEnabled: () => {},
          setShowPromptCost: () => {},
        },
      },
    });
    try {
      expect(host.openSurface("settings")).toBe(true);
      expect(host.shell.overlayKind).toBe("settings");
      closeInsetOverlay(host.shell);
      // onModelSelect being wired is enough to open the picker, even with an
      // empty catalog (nothing to pick yet, but the surface itself opens).
      expect(host.openSurface("models")).toBe(true);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });
});

describe("mountRunnerHost model picker", () => {
  test("refreshModels moves a selected pair into the Recent section", async () => {
    const harness = await createHarness({ width: 80, height: 24 });
    const host = await mountRunnerHost({
      title: "test",
      eventEmitter: new EventEmitter(),
      send: () => {},
      interrupt: () => {},
      providers: { xai: { models: ["grok-4", "grok-3"] } },
      activeModel: () => ({ provider: "xai", model: "grok-4" }),
      onModelSelect: () => {},
      commands: [],
      onCommand: () => {},
      chrome: () => ({ agents: [] }),
      subscribeChrome: () => () => {},
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
    });
    try {
      host.refreshModels([{ provider: "xai", model: "grok-4" }], []);
      closeInsetOverlay(host.shell);
      expect(host.openSurface("models")).toBe(true);
      expect(host.shell.overlayItems[0]).toBe("grok-4 * [xai] (current)");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("refreshModels swaps in a freshly connected provider's models without a remount", async () => {
    // Mount-time deps are a snapshot; a live provider connect (CL-5602) must be
    // able to replace them without remounting the host, or the newly connected
    // provider's models never appear.
    const harness = await createHarness({ width: 80, height: 24 });
    const host = await mountRunnerHost({
      title: "test",
      eventEmitter: new EventEmitter(),
      send: () => {},
      interrupt: () => {},
      providers: { xai: { models: ["grok-4"] } },
      onModelSelect: () => {},
      commands: [],
      onCommand: () => {},
      chrome: () => ({ agents: [] }),
      subscribeChrome: () => () => {},
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
    });
    try {
      host.refreshModels([], [], { xai: { models: ["grok-4"] }, openai: { models: ["gpt-5"] } });
      expect(host.openSurface("models")).toBe(true);
      // Flat list: the new provider appears as a leaf `model * [provider]` row,
      // not a nested group to drill into.
      expect(host.shell.overlayItems.some((label) => label.includes("openai"))).toBe(true);
      expect(host.shell.overlayItems.some((label) => label.includes("gpt-5"))).toBe(true);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("f toggles favorite on the focused row via onFavoriteToggle", async () => {
    const harness = await createHarness({ width: 80, height: 24 });
    const toggled: string[] = [];
    const host = await mountRunnerHost({
      title: "test",
      eventEmitter: new EventEmitter(),
      send: () => {},
      interrupt: () => {},
      providers: { xai: { models: ["grok-4"] } },
      onModelSelect: () => {},
      onFavoriteToggle: (id) => toggled.push(id),
      commands: [],
      onCommand: () => {},
      chrome: () => ({ agents: [] }),
      subscribeChrome: () => () => {},
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
    });
    try {
      expect(host.openSurface("models")).toBe(true);
      // Flat list: the model row is already focusable at the top level —
      // Alt+F toggles favorite without a nested provider drill.
      const fKey = { name: "f", ctrl: false, meta: false, option: true } as KeyEvent;
      expect(runOverlayAction(host.shell, fKey)).toBe(true);
      expect(toggled).toEqual(["xai:grok-4"]);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("Alt+D sets default on the focused row via onSetDefault", async () => {
    const harness = await createHarness({ width: 80, height: 24 });
    const setDefault: string[] = [];
    const host = await mountRunnerHost({
      title: "test",
      eventEmitter: new EventEmitter(),
      send: () => {},
      interrupt: () => {},
      providers: { xai: { models: ["grok-4"] } },
      onModelSelect: () => {},
      onSetDefault: (id) => setDefault.push(id),
      commands: [],
      onCommand: () => {},
      chrome: () => ({ agents: [] }),
      subscribeChrome: () => () => {},
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
    });
    try {
      expect(host.openSurface("models")).toBe(true);
      const dKey = { name: "d", ctrl: false, meta: false, option: true } as KeyEvent;
      expect(runOverlayAction(host.shell, dKey)).toBe(true);
      expect(setDefault).toEqual(["xai:grok-4"]);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("Alt+A opens the add-provider selector built from addProviderChoices", async () => {
    const harness = await createHarness({ width: 80, height: 24 });
    const connected: string[] = [];
    const host = await mountRunnerHost({
      title: "test",
      eventEmitter: new EventEmitter(),
      send: () => {},
      interrupt: () => {},
      providers: { xai: { models: ["grok-4"] } },
      onModelSelect: () => {},
      onConnectProvider: (name) => connected.push(name),
      addProviderChoices: () => [
        { id: "codex", label: "Codex", hint: "", accountCount: 1 },
        { id: "openai", label: "OpenAI", hint: "", accountCount: 0 },
      ],
      commands: [],
      onCommand: () => {},
      chrome: () => ({ agents: [] }),
      subscribeChrome: () => () => {},
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
    });
    try {
      expect(host.openSurface("models")).toBe(true);
      const altA = { name: "a", ctrl: false, meta: false, option: true } as KeyEvent;
      expect(runOverlayAction(host.shell, altA)).toBe(true);
      expect(host.shell.overlayKind).toBe("add_provider");
      expect(host.shell.overlayItems).toEqual(["Codex — 1 account", "OpenAI — 0 accounts"]);
      acceptOverlaySelection(host.shell);
      expect(connected).toEqual(["codex"]);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });
});

describe("bottom border cost run", () => {
  test("omits the cost run when showPromptCost is unset (default off)", async () => {
    const harness = await createHarness({ width: 80, height: 24 });
    const host = await mountRunnerHost({
      title: "test",
      eventEmitter: new EventEmitter(),
      send: () => {},
      interrupt: () => {},
      providers: {},
      onModelSelect: () => {},
      commands: [],
      onCommand: () => {},
      chrome: () => ({ agents: [] }),
      subscribeChrome: () => () => {},
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
      readCostSummary: () => fakeCostSummary(),
    });
    try {
      const bottom = ruleOf(host.shell.promptBottomRule);
      expect(bottom).toContain("10%");
      expect(bottom).not.toContain("$0.42");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("shows the cost run when showPromptCost reads true, and refreshCostContext repaints it live", async () => {
    const harness = await createHarness({ width: 80, height: 24 });
    let showCost = false;
    const host = await mountRunnerHost({
      title: "test",
      eventEmitter: new EventEmitter(),
      send: () => {},
      interrupt: () => {},
      providers: {},
      onModelSelect: () => {},
      commands: [],
      onCommand: () => {},
      chrome: () => ({ agents: [] }),
      subscribeChrome: () => () => {},
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
      readCostSummary: () => fakeCostSummary(),
      showPromptCost: () => showCost,
    });
    try {
      expect(ruleOf(host.shell.promptBottomRule)).not.toContain("$0.42");

      showCost = true;
      host.refreshCostContext();
      expect(ruleOf(host.shell.promptBottomRule)).toContain("$0.42");
      expect(ruleOf(host.shell.promptBottomRule)).toContain("10%");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("session.clear paints the context meter unknown immediately", async () => {
    const harness = await createHarness({ width: 80, height: 24 });
    const emitter = new EventEmitter();
    const host = await mountRunnerHost({
      title: "test",
      eventEmitter: emitter,
      send: () => {},
      interrupt: () => {},
      providers: {},
      onModelSelect: () => {},
      commands: [],
      onCommand: () => {},
      chrome: () => ({ agents: [] }),
      subscribeChrome: () => () => {},
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
      // Stale occupancy — refreshCostContext would re-paint this if clear
      // re-read before rotation finished.
      readCostSummary: () => fakeCostSummary(),
    });
    try {
      expect(ruleOf(host.shell.promptBottomRule)).toContain("10%");
      expect(host.shell.costContext).not.toBeNull();

      emitter.emit("session.clear");

      expect(host.shell.costContext).toBeNull();
      expect(ruleOf(host.shell.promptBottomRule)).not.toContain("10%");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("inference.start refreshes the cost meter from the live summary", async () => {
    const harness = await createHarness({ width: 80, height: 24 });
    const emitter = new EventEmitter();
    let percent = 10;
    const host = await mountRunnerHost({
      title: "test",
      eventEmitter: emitter,
      send: () => {},
      interrupt: () => {},
      providers: {},
      onModelSelect: () => {},
      commands: [],
      onCommand: () => {},
      chrome: () => ({ agents: [] }),
      subscribeChrome: () => () => {},
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
      readCostSummary: () => ({ ...fakeCostSummary(), contextPercentUsed: percent }),
    });
    try {
      expect(ruleOf(host.shell.promptBottomRule)).toContain("10%");

      percent = 42;
      emitter.emit("event", { type: "inference.start" });

      expect(ruleOf(host.shell.promptBottomRule)).toContain("42%");
      expect(ruleOf(host.shell.promptBottomRule)).not.toContain("10%");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("connector.reply refreshes the cost meter after idle compact meter-sync", async () => {
    const harness = await createHarness({ width: 80, height: 24 });
    const emitter = new EventEmitter();
    let percent = 90;
    const host = await mountRunnerHost({
      title: "test",
      eventEmitter: emitter,
      send: () => {},
      interrupt: () => {},
      providers: {},
      onModelSelect: () => {},
      commands: [],
      onCommand: () => {},
      chrome: () => ({ agents: [] }),
      subscribeChrome: () => () => {},
      subAgentSessions: () => [],
      createRenderer: async () => harness.renderer,
      readCostSummary: () => ({ ...fakeCostSummary(), contextPercentUsed: percent }),
    });
    try {
      expect(ruleOf(host.shell.promptBottomRule)).toContain("90%");

      percent = 12;
      emitter.emit("event", { type: "connector.reply", data: { content: "" } });

      expect(ruleOf(host.shell.promptBottomRule)).toContain("12%");
      expect(ruleOf(host.shell.promptBottomRule)).not.toContain("90%");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });
});

/** Resolves true when the host exited, false when it is still alive. */
async function exited(host: { waitUntilExit: () => Promise<void> }): Promise<boolean> {
  return await Promise.race([
    host.waitUntilExit().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
}

describe("mountRunnerHost quit key", () => {
  const baseDeps = (harness: Awaited<ReturnType<typeof createHarness>>) => ({
    title: "test",
    eventEmitter: new EventEmitter(),
    send: () => {},
    interrupt: () => {},
    providers: {},
    onModelSelect: () => {},
    commands: [],
    onCommand: () => {},
    chrome: () => ({ agents: [] }),
    subscribeChrome: () => () => {},
    subAgentSessions: () => [],
    createRenderer: async () => harness.renderer,
  });

  test("Ctrl+D mid-edit keeps the draft and the app alive", async () => {
    const harness = await createHarness({ width: 80, height: 24 });
    const host = await mountRunnerHost(baseDeps(harness));
    try {
      for (const ch of "foo bar") harness.pressKey(ch);
      await harness.renderOnce();
      harness.pressKey("ARROW_LEFT");
      harness.pressKey("d", { ctrl: true });
      await harness.renderOnce();

      // Ctrl+D falls through to the textarea's delete-under-cursor.
      expect(host.shell.prompt.value).toBe("foo ba");
      expect(await exited(host)).toBe(false);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  // Quitting is Ctrl+C. The host claims no key of its own, so an empty
  // prompt is not a special case: Ctrl+D stays the prompt's own binding.
  test("Ctrl+D at an empty prompt does not quit", async () => {
    const harness = await createHarness({ width: 80, height: 24 });
    const host = await mountRunnerHost(baseDeps(harness));
    try {
      expect(host.shell.prompt.value).toBe("");
      harness.pressKey("d", { ctrl: true });
      await harness.renderOnce();

      expect(await exited(host)).toBe(false);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });
});
