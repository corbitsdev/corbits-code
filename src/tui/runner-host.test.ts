import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";

import type { KeyEvent } from "@opentui/core";

import type { CostSummary } from "../cost/cost-summary.js";
import type { SubAgentSession } from "../subagent/session-store.js";
import { createHarness, type Harness } from "./harness.js";
import { modelOptionId, modelOptionRef } from "./model-catalog.js";
import {
  acceptOverlaySelection,
  closeInsetOverlay,
} from "./shell/overlay-host.js";
import {
  moveOverlaySelection,
  runOverlayAction,
} from "./shell/overlay-list.js";
import { resolvePaletteCatalog } from "./shell/palette.js";
import { setShellRunState } from "./shell/chrome.js";
import {
  mountRunnerHost,
  observeSessionFromSubAgents,
  rowFromTranscriptEntry,
  type RunnerHost,
  type RunnerHostDeps,
} from "./runner/host.js";

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
    sessionBillingMix: "none",
    contextWindow: 10000,
    contextPercentUsed: 10,
  };
}

/**
 * Mount a runner host on a headless renderer with no-op deps; `deps`
 * carries only what the test exercises. Host and harness are torn down.
 */
async function withRunnerHost(
  fn: (host: RunnerHost, harness: Harness) => Promise<void> | void,
  deps: Partial<RunnerHostDeps> = {},
): Promise<void> {
  const harness = await createHarness({ width: 80, height: 24 });
  const host = await mountRunnerHost({
    title: "test",
    eventEmitter: new EventEmitter(),
    send: () => undefined,
    interrupt: () => undefined,
    deliver: () => undefined,
    providers: {},
    onModelSelect: () => undefined,
    commands: [],
    onCommand: () => undefined,
    chrome: () => ({ agents: [] }),
    subscribeChrome: () => () => undefined,
    subAgentSessions: () => [],
    createRenderer: async () => harness.renderer,
    ...deps,
  });
  try {
    await fn(host, harness);
  } finally {
    host.dispose();
    harness.destroy();
  }
}

function session(over: Partial<SubAgentSession>): SubAgentSession {
  return {
    id: "s1",
    description: "explore callers",
    agentId: "explorer",
    brief: "",
    status: "running",
    lifecycle: { state: "running" },
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
    expect(rowFromTranscriptEntry({ kind: "thinking", content: "hm" })).toEqual(
      {
        role: "system",
        text: "hm",
        meta: "thinking",
      },
    );
    expect(
      rowFromTranscriptEntry({
        kind: "tool",
        callId: "c",
        name: "grep",
        arguments: "{}",
      }),
    ).toEqual({
      role: "tool",
      text: "{}",
      meta: "grep",
      toolName: "grep",
      verb: "Grep",
      // Empty summary is intentional: without it the paint layer falls
      // through to raw argument JSON. Verb alone names the call.
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
    ).toEqual({
      role: "tool",
      text: "boom",
      meta: "grep",
      toolName: "grep",
      failed: true,
      callId: "c",
    });
    expect(rowFromTranscriptEntry({ kind: "report", content: "done" })).toEqual(
      {
        role: "assistant",
        text: "done",
        meta: "report",
      },
    );
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

describe("mountRunnerHost session bridge", () => {
  test("exposes the live session bridge so a system continuation can mark the run busy", async () => {
    await withRunnerHost(async (host) => {
      expect(typeof host.bridge.beginSystemContinuation).toBe("function");
      expect(host.shell.session.run).toBe("idle");
      host.bridge.beginSystemContinuation(
        "The fleet has gone dry. Remaining open tasks:\n- t1: keep going (todo)",
      );
      expect(host.shell.session.run).toBe("busy");
    });
  });

  test("opens credential recovery only after the shell is idle", async () => {
    const accepted: string[] = [];
    const args = {
      alternatives: [
        {
          id: modelOptionId("backup", "model-a"),
          label: "model-a * [backup]",
          provider: "backup",
          model: "model-a",
        },
      ],
      onAccept: (id: string) => accepted.push(id),
      onCancel: () => undefined,
    };
    await withRunnerHost(async (host) => {
      host.bridge.beginSystemContinuation("busy");
      expect(host.openCredentialRecovery(args)).toBe(false);
      expect(host.shell.overlayKind).toBeNull();

      setShellRunState(host.shell, "idle");
      expect(host.openCredentialRecovery(args)).toBe(true);
      expect(host.shell.overlayKind).toBe("model_picker");
      expect(host.shell.overlayItems).toEqual(["model-a * [backup]"]);
      acceptOverlaySelection(host.shell);
      expect(accepted).toEqual([modelOptionId("backup", "model-a")]);
    });
  });
});

describe("mountRunnerHost chrome wiring", () => {
  test("reads the current command catalog on every palette access", async () => {
    let commands = [{ name: "first", description: "First command" }];
    await withRunnerHost(
      async (host) => {
        expect(
          resolvePaletteCatalog(host.shell).map((command) => command.id),
        ).toEqual(["first"]);

        commands = [{ name: "second", description: "Second command" }];
        expect(
          resolvePaletteCatalog(host.shell).map((command) => command.id),
        ).toEqual(["second"]);
      },
      { commands: () => commands },
    );
  });

  // subscribeChrome must stay wired end-to-end. formatChromeZones now parks
  // both chrome strips (always null), so a tasks push must not paint the
  // checklist — this test asserts the notify path still runs and leaves the
  // task panel empty (rebuild later; live work is spawn_agent rows).
  test("a live chrome push (subscribeChrome notify) does not auto-paint the task panel", async () => {
    let liveTasks: readonly {
      title: string;
      status: "todo" | "doing" | "done" | "cancelled";
    }[] = [];
    let notify: (() => void) | undefined;
    await withRunnerHost(
      async (host, harness) => {
        expect(host.shell.taskBox.visible).toBe(false);
        expect(notify).toBeDefined();

        // Mirrors the chat tasks-changed event path: live source changes, then
        // the runner notifies the host. formatChromeZones parks the checklist.
        liveTasks = [{ title: "wire task panel", status: "doing" }];
        notify?.();

        expect(host.shell.taskBox.visible).toBe(false);
        await harness.renderOnce();
        const frame = harness.captureCharFrame();
        expect(frame).not.toContain("wire task panel");
        // Notify callback stayed registered — subscribe path ran without error.
        expect(notify).toBeDefined();
      },
      {
        chrome: () => ({ tasks: liveTasks, agents: [] }),
        subscribeChrome: (n) => {
          notify = n;
          return () => {
            notify = undefined;
          };
        },
      },
    );
  });
});

describe("mountRunnerHost command surfaces", () => {
  test("routes settings and models, and reports surfaces with no data source", async () => {
    await withRunnerHost(
      async (host) => {
        expect(host.openSurface("settings")).toBe(true);
        expect(host.shell.overlayKind).toBe("settings");
        closeInsetOverlay(host.shell);
        // onModelSelect being wired is enough to open the picker, even with
        // an empty catalog (nothing to pick yet, but the surface opens).
        expect(host.openSurface("models")).toBe(true);
      },
      {
        surfaces: {
          settings: {
            read: () => ({
              waitForApproval: true,
              telemetryEnabled: false,
              showPromptCost: false,
              theme: "auto",
            }),
            setWaitForApproval: () => undefined,
            setTelemetryEnabled: () => undefined,
            setShowPromptCost: () => undefined,
            setTheme: () => undefined,
          },
        },
      },
    );
  });
});

describe("mountRunnerHost model picker", () => {
  test("refreshModels moves a selected pair into the Recent section", async () => {
    await withRunnerHost(
      async (host) => {
        host.refreshModels([{ provider: "xai", model: "grok-4" }], []);
        closeInsetOverlay(host.shell);
        expect(host.openSurface("models")).toBe(true);
        expect(host.shell.overlayItems[0]).toBe("grok-4 * [xai] (current)");
      },
      {
        providers: { xai: { models: ["grok-4", "grok-3"] } },
        activeModel: () => ({ provider: "xai", model: "grok-4" }),
      },
    );
  });

  test("refreshModels swaps in a freshly connected provider's models without a remount", async () => {
    // Mount-time deps are a snapshot; a live provider connect must be able
    // to replace them without remounting the host, or the newly connected
    // provider's models never appear.
    await withRunnerHost(
      async (host) => {
        host.refreshModels([], [], {
          xai: { models: ["grok-4"] },
          openai: { models: ["gpt-5"] },
        });
        expect(host.openSurface("models")).toBe(true);
        // Flat list: the new provider appears as a leaf `model * [provider]` row,
        // not a nested group to drill into.
        expect(
          host.shell.overlayItems.some((label) => label.includes("openai")),
        ).toBe(true);
        expect(
          host.shell.overlayItems.some((label) => label.includes("gpt-5")),
        ).toBe(true);
      },
      { providers: { xai: { models: ["grok-4"] } } },
    );
  });

  // Flat list: the model row is already focusable at the top level, so the
  // Alt+ chords act on it without a nested provider drill.
  test.each([
    { key: "f", dep: "onFavoriteToggle" as const },
    { key: "d", dep: "onSetDefault" as const },
  ])("Alt+$key routes the focused row to $dep", async ({ key, dep }) => {
    const hits: string[] = [];
    await withRunnerHost(
      async (host) => {
        expect(host.openSurface("models")).toBe(true);
        const event = {
          name: key,
          ctrl: false,
          meta: false,
          option: true,
        } as KeyEvent;
        expect(runOverlayAction(host.shell, event)).toBe(true);
        expect(hits).toEqual([modelOptionId("xai", "grok-4")]);
      },
      {
        providers: { xai: { models: ["grok-4"] } },
        [dep]: (id: string) => hits.push(id),
      },
    );
  });

  test("Alt+A opens the add-provider selector built from addProviderChoices", async () => {
    const connected: string[] = [];
    await withRunnerHost(
      async (host) => {
        expect(host.openSurface("models")).toBe(true);
        const altA = {
          name: "a",
          ctrl: false,
          meta: false,
          option: true,
        } as KeyEvent;
        expect(runOverlayAction(host.shell, altA)).toBe(true);
        expect(host.shell.overlayKind).toBe("add_provider");
        expect(host.shell.overlayItems).toEqual([
          "Codex — 1 account",
          "OpenAI — 0 accounts",
        ]);
        acceptOverlaySelection(host.shell);
        expect(connected).toEqual(["codex"]);
      },
      {
        providers: { xai: { models: ["grok-4"] } },
        onConnectProvider: (name) => connected.push(name),
        addProviderChoices: () => [
          { id: "codex", label: "Codex", hint: "", accountCount: 1 },
          { id: "openai", label: "OpenAI", hint: "", accountCount: 0 },
        ],
      },
    );
  });

  test("openSurface add-provider returns false when add-provider is not wired", async () => {
    await withRunnerHost(
      async (host) => {
        expect(host.openSurface("add-provider")).toBe(false);
        expect(host.shell.overlayKind).not.toBe("add_provider");
      },
      { providers: { xai: { models: ["grok-4"] } } },
    );
  });
});

describe("bottom border cost run", () => {
  test("omits the cost run when showPromptCost is unset (default off)", async () => {
    await withRunnerHost(
      async (host) => {
        const bottom = ruleOf(host.shell.promptBottomRule);
        expect(bottom).toContain("10%");
        expect(bottom).not.toContain("$0.42");
      },
      { readCostSummary: () => fakeCostSummary() },
    );
  });

  test("shows the cost run when showPromptCost reads true, and refreshCostContext repaints it live", async () => {
    let showCost = false;
    await withRunnerHost(
      async (host) => {
        expect(ruleOf(host.shell.promptBottomRule)).not.toContain("$0.42");

        showCost = true;
        host.refreshCostContext();
        expect(ruleOf(host.shell.promptBottomRule)).toContain("$0.42");
        expect(ruleOf(host.shell.promptBottomRule)).toContain("10%");
      },
      {
        readCostSummary: () => fakeCostSummary(),
        showPromptCost: () => showCost,
      },
    );
  });

  // The bottom-rule $ tracks the newly selected provider immediately — the
  // wait-for-inference lag was the bug. Codex (chatgpt-subscription) has no
  // metered cost; xai does.
  test.each([
    {
      name: "a Codex model hides prompt $",
      from: "xai",
      rowIncludes: "codex/acme-labs",
      toProvider: "codex/acme-labs",
      showCost: false,
    },
    {
      name: "a metered model from Codex shows prompt $",
      from: "codex/acme-labs",
      rowIncludes: "[xai]",
      toProvider: "xai",
      showCost: true,
    },
  ])(
    "selecting $name — without waiting for inference",
    async ({ from, rowIncludes, toProvider, showCost }) => {
      let provider: string = from;
      await withRunnerHost(
        async (host) => {
          expect(ruleOf(host.shell.promptBottomRule).includes("$0.42")).toBe(
            !showCost,
          );

          expect(host.openSurface("models")).toBe(true);
          const index = host.shell.overlayItems.findIndex((label) =>
            label.includes(rowIncludes),
          );
          expect(index).toBeGreaterThanOrEqual(0);
          moveOverlaySelection(host.shell, index);
          acceptOverlaySelection(host.shell);

          expect(provider).toBe(toProvider);
          const rule = ruleOf(host.shell.promptBottomRule);
          expect(rule.includes("$0.42")).toBe(showCost);
          expect(host.shell.costContext?.costLabel ?? null).toBe(
            showCost ? "$0.42" : null,
          );
          expect(rule).toContain("10%");
        },
        {
          providers: {
            xai: { models: ["grok-4"] },
            "codex/acme-labs": { models: ["gpt-5.5"] },
          },
          onModelSelect: (id) => {
            const identity = modelOptionRef(id);
            if (identity !== null) provider = identity.provider;
          },
          readCostSummary: () => ({
            ...fakeCostSummary(),
            costHiddenReason: provider.startsWith("codex/")
              ? "chatgpt-subscription"
              : null,
          }),
          showPromptCost: () => true,
        },
      );
    },
  );

  test("session.clear paints the context meter unknown immediately", async () => {
    const emitter = new EventEmitter();
    await withRunnerHost(
      async (host) => {
        expect(ruleOf(host.shell.promptBottomRule)).toContain("10%");
        expect(host.shell.costContext).not.toBeNull();

        emitter.emit("session.clear");

        expect(host.shell.costContext).toBeNull();
        expect(ruleOf(host.shell.promptBottomRule)).not.toContain("10%");
      },
      {
        eventEmitter: emitter,
        // Stale occupancy — refreshCostContext would re-paint this if clear
        // re-read before rotation finished.
        readCostSummary: () => fakeCostSummary(),
      },
    );
  });

  test.each([
    { type: "inference.start", from: 10, to: 42 },
    { type: "connector.reply", from: 90, to: 12 },
  ])(
    "$type refreshes the cost meter from the live summary",
    async ({ type, from, to }) => {
      const emitter = new EventEmitter();
      let percent: number = from;
      await withRunnerHost(
        async (host) => {
          expect(ruleOf(host.shell.promptBottomRule)).toContain(`${from}%`);

          percent = to;
          emitter.emit("event", { type, data: { content: "" } });

          const rule = ruleOf(host.shell.promptBottomRule);
          expect(rule).toContain(`${to}%`);
          expect(rule).not.toContain(`${from}%`);
        },
        {
          eventEmitter: emitter,
          readCostSummary: () => ({
            ...fakeCostSummary(),
            contextPercentUsed: percent,
          }),
        },
      );
    },
  );
});

// The mounted-host Ctrl+D contract (prompt's own binding, never quit) is
// probed in keybindings.test.ts — no duplicate here.
