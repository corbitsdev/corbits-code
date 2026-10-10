/**
 * Unit tests for product-host: pure helpers plus mount-level coverage of
 * `mountProductHost` using the headless harness and fakes.
 */
import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { TextRenderable, type KeyEvent } from "@opentui/core";
import type { ConversationTurn } from "@intx/types/runtime";
import { defined } from "../../testkit/defined.js";
import { createHarness, type Harness } from "./harness.js";
import { acceptOverlaySelection } from "./shell/overlay-host.js";
import {
  moveOverlaySelection,
  runOverlayAction,
} from "./shell/overlay-list.js";
import { handleListFilterKey } from "./shell/palette.js";
import { PRIMARY_ASK_OPERATOR_SOURCE } from "./gate-events.js";
import { NO_OPERATOR_INPUT_REQUIRED } from "./operator-input-required.js";
import {
  decideRemoveKey,
  mountProductHost,
  REMOVE_ARM_MS,
  type ProductHostConfig,
} from "./product-host.js";
import { buildModelsFirstCatalog, modelOptionId } from "./model-catalog.js";
import { hydrateHistoryRows } from "./history-hydrate.js";
import { MAX_RETAINED_STREAM_ROWS } from "./long-log.js";
import { turnsToContentBlocks } from "./turns-to-blocks.js";
import { enterSubagentObserve } from "./shell/observe.js";
import { toggleRowExpandedAt } from "./shell/chrome.js";
import { streamRowAt, transcriptMarker } from "./shell/transcript.js";
import { isCollapsibleRow } from "./stream.js";
import type { AppShell } from "./shell/internals.js";

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

async function mountHeadless(
  overrides: Partial<ProductHostConfig> = {},
): Promise<{
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

/** Type `text` into the filter row through the harness key path. */
async function typeFilter(harness: Harness, text: string): Promise<void> {
  for (const ch of text) {
    harness.pressKey(ch);
  }
  await harness.renderOnce();
}

/** A printable key event for a composed Option glyph (Option+D → ∂). */
function composedKey(glyph: string): KeyEvent {
  return {
    name: glyph,
    sequence: glyph,
    ctrl: false,
    meta: false,
    option: false,
  } as KeyEvent;
}

function userTextTurn(text: string): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  } as unknown as ConversationTurn;
}

function spawnCallTurn(id: string): ConversationTurn {
  return {
    role: "assistant",
    model: "test",
    timestamp: 0,
    content: [
      {
        type: "tool_call",
        id,
        name: "spawn_agent",
        arguments: { description: `job-${id}` },
      },
    ],
  } as unknown as ConversationTurn;
}

function spawnResultTurn(id: string): ConversationTurn {
  return {
    role: "assistant",
    model: "test",
    timestamp: 0,
    content: [
      {
        type: "tool_result",
        callId: id,
        content: `done ${id}`,
        isError: false,
      },
    ],
  } as unknown as ConversationTurn;
}

function markerNotice(shell: AppShell): string {
  const marker = transcriptMarker(shell);
  expect(marker).toBeInstanceOf(TextRenderable);
  const content = (marker as TextRenderable).content;
  return typeof content === "string" ? content : String(content);
}

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

  test("history.hydrate caps oversized history at the newest retained rows (CL-9008)", async () => {
    const { host, emitter } = await mountHeadless();
    try {
      const total = MAX_RETAINED_STREAM_ROWS + 200;
      const blocks = Array.from({ length: total }, (_, i) => ({
        type: "text",
        content: `row-${i}`,
      }));
      emitter.emit("history.hydrate", blocks);
      expect(host.shell.streamLog.length).toBe(MAX_RETAINED_STREAM_ROWS);
      expect(host.shell.streamLog[0]).toEqual({
        role: "assistant",
        text: `row-${total - MAX_RETAINED_STREAM_ROWS}`,
      });
      expect(host.shell.streamLog[MAX_RETAINED_STREAM_ROWS - 1]).toEqual({
        role: "assistant",
        text: `row-${total - 1}`,
      });
      const dropped = total - MAX_RETAINED_STREAM_ROWS;
      expect(host.shell.streamLogBase).toBe(dropped);
      expect(transcriptMarker(host.shell)).toBeDefined();
    } finally {
      host.dispose();
    }
  });

  test("history.hydrate below the cap paints every row (CL-9008)", async () => {
    const { host, emitter } = await mountHeadless();
    try {
      const total = MAX_RETAINED_STREAM_ROWS - 100;
      const blocks = Array.from({ length: total }, (_, i) => ({
        type: "text",
        content: `small-${i}`,
      }));
      emitter.emit("history.hydrate", blocks);
      expect(host.shell.streamLog.length).toBe(total);
      expect(host.shell.streamLog[0]).toEqual({
        role: "assistant",
        text: "small-0",
      });
      expect(host.shell.streamLog[total - 1]).toEqual({
        role: "assistant",
        text: `small-${total - 1}`,
      });
      expect(host.shell.streamLogBase).toBe(0);
      expect(transcriptMarker(host.shell)).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  test("history.hydrate keeps a tool pair merged atomically across the cap boundary (CL-9008)", async () => {
    const { host, emitter } = await mountHeadless();
    try {
      const blocks = [
        ...Array.from({ length: 605 }, (_, i) => ({
          type: "text",
          content: `row-${i}`,
        })),
        {
          type: "tool_call",
          name: "spawn_agent",
          arguments: '{"description":"Fix CL-9008"}',
          callId: "cut-1",
        },
        {
          type: "tool_result",
          name: "spawn_agent",
          content: "done cut-1",
          callId: "cut-1",
        },
      ];
      emitter.emit("history.hydrate", blocks);
      // Folding merges the pair inside hydration, so retention evicts whole
      // merged rows: 605 texts + 1 merged row → newest 600. A block-level
      // slice would split the pair and paint 599 rows instead.
      const allRows = hydrateHistoryRows(blocks);
      const expected = allRows.slice(-MAX_RETAINED_STREAM_ROWS);
      const dropped = allRows.length - expected.length;
      expect(expected.length).toBe(MAX_RETAINED_STREAM_ROWS);
      expect(host.shell.streamLog).toEqual(expected);
      expect(host.shell.streamLog[0]).toEqual({
        role: "assistant",
        text: "row-6",
      });
      const last = host.shell.streamLog[host.shell.streamLog.length - 1];
      expect(last?.pending).not.toBe(true);
      expect(last?.text).toBe("done cut-1");
      expect(dropped).toBeGreaterThan(0);
      expect(host.shell.streamLogBase).toBe(dropped);
      expect(transcriptMarker(host.shell)).toBeDefined();
    } finally {
      host.dispose();
    }
  });

  test("history.hydrate in observe mode lands the capped tail on the parent log (CL-9008)", async () => {
    const { host, emitter } = await mountHeadless();
    try {
      enterSubagentObserve(host.shell, {
        sessionId: "child-keeper",
        agentId: "explorer",
        description: "observe-mode hydrate keeper",
        lines: [],
      });
      expect(host.shell.parentStreamLog).toEqual([]);
      const visibleBefore = host.shell.streamLog.length;
      const total = MAX_RETAINED_STREAM_ROWS + 200;
      const blocks = Array.from({ length: total }, (_, i) => ({
        type: "text",
        content: `obs-row-${i}`,
      }));
      emitter.emit("history.hydrate", blocks);
      // Observe routes hydrate rows to the parent snapshot only; the child
      // view on screen is untouched.
      expect(host.shell.streamLog.length).toBe(visibleBefore);
      const expected = hydrateHistoryRows(blocks).slice(
        -MAX_RETAINED_STREAM_ROWS,
      );
      expect(host.shell.parentStreamLog).toEqual(expected);
      expect(host.shell.parentStreamLog?.length).toBe(MAX_RETAINED_STREAM_ROWS);
      expect(host.shell.parentStreamLogBase).toBe(
        total - MAX_RETAINED_STREAM_ROWS,
      );
      expect(host.shell.streamLogBase).toBe(0);
      expect(transcriptMarker(host.shell)).toBeUndefined();
    } finally {
      host.dispose();
    }
  });

  test("resume pipeline of long text history paints the eviction marker", async () => {
    const { host, emitter } = await mountHeadless();
    try {
      const total = MAX_RETAINED_STREAM_ROWS + 200;
      const turns = Array.from({ length: total }, (_, i) =>
        userTextTurn(`row-${i}`),
      );
      const blocks = turnsToContentBlocks(turns);
      emitter.emit("history.hydrate", blocks);
      expect(host.shell.streamLog.length).toBe(MAX_RETAINED_STREAM_ROWS);
      expect(host.shell.streamLogBase).toBe(200);
      expect(host.shell.streamLog[0]).toEqual({
        role: "user",
        text: "row-200",
      });
      expect(transcriptMarker(host.shell)).toBeDefined();
    } finally {
      host.dispose();
    }
  });

  test("resume pipeline of tool pairs fills the retained row cap", async () => {
    const { host, emitter } = await mountHeadless();
    try {
      const pairCount = MAX_RETAINED_STREAM_ROWS + 200;
      const turns: ConversationTurn[] = [];
      for (let i = 0; i < pairCount; i++) {
        turns.push(spawnCallTurn(`p${i}`), spawnResultTurn(`p${i}`));
      }
      const blocks = turnsToContentBlocks(turns);
      emitter.emit("history.hydrate", blocks);
      expect(host.shell.streamLog.length).toBe(MAX_RETAINED_STREAM_ROWS);
      expect(host.shell.streamLogBase).toBe(200);
      const first = host.shell.streamLog[0];
      expect(first?.pending).not.toBe(true);
      expect(first?.text).toBe("done p200");
      const last = host.shell.streamLog[host.shell.streamLog.length - 1];
      expect(last?.pending).not.toBe(true);
      expect(last?.text).toBe(`done p${pairCount - 1}`);
      expect(transcriptMarker(host.shell)).toBeDefined();
    } finally {
      host.dispose();
    }
  });

  test("resume pipeline keeps a pair merged when it straddles the old block splice", async () => {
    const { host, emitter } = await mountHeadless();
    try {
      const turns: ConversationTurn[] = [];
      for (let i = 0; i < 400; i++) {
        turns.push(spawnCallTurn(`c${i}`), spawnResultTurn(`c${i}`));
      }
      turns.push(userTextTurn("trailing"));
      const blocks = turnsToContentBlocks(turns);
      emitter.emit("history.hydrate", { blocks, truncated: false });
      expect(host.shell.streamLog.length).toBe(401);
      expect(host.shell.streamLog[0]?.pending).not.toBe(true);
      expect(host.shell.streamLog[0]?.text).toBe("done c0");
      expect(host.shell.streamLog[host.shell.streamLog.length - 1]).toEqual({
        role: "user",
        text: "trailing",
      });
      expect(host.shell.streamLogBase).toBe(0);
    } finally {
      host.dispose();
    }
  });

  test("resume pipeline keeps a pair merged across the retained row cap", async () => {
    const { host, emitter } = await mountHeadless();
    try {
      const turns = [
        ...Array.from({ length: 605 }, (_, i) => userTextTurn(`row-${i}`)),
        spawnCallTurn("cut-1"),
        spawnResultTurn("cut-1"),
      ];
      const blocks = turnsToContentBlocks(turns);
      emitter.emit("history.hydrate", blocks);
      const allRows = hydrateHistoryRows(blocks);
      const expected = allRows.slice(-MAX_RETAINED_STREAM_ROWS);
      expect(host.shell.streamLog).toEqual(expected);
      const last = host.shell.streamLog[host.shell.streamLog.length - 1];
      expect(last?.pending).not.toBe(true);
      expect(last?.text).toBe("done cut-1");
      expect(host.shell.streamLogBase).toBeGreaterThan(0);
      expect(transcriptMarker(host.shell)).toBeDefined();
    } finally {
      host.dispose();
    }
  });

  test("truncated load of an exact-cap tail still paints the eviction marker", async () => {
    const { host, emitter } = await mountHeadless();
    try {
      const turns = Array.from({ length: MAX_RETAINED_STREAM_ROWS }, (_, i) =>
        userTextTurn(`kept-${i}`),
      );
      const blocks = turnsToContentBlocks(turns);
      emitter.emit("history.hydrate", { blocks, truncated: true });
      expect(host.shell.streamLog.length).toBe(MAX_RETAINED_STREAM_ROWS);
      expect(host.shell.streamLogBase).toBe(0);
      expect(streamRowAt(host.shell, 0)).toEqual(
        defined(host.shell.streamLog[0]),
      );
      expect(transcriptMarker(host.shell)).toBeDefined();
      expect(markerNotice(host.shell)).not.toMatch(/\b1 earlier row\b/);
    } finally {
      host.dispose();
    }
  });

  test("truncated hydrate keeps the first retained tool row clickable", async () => {
    const { host, emitter } = await mountHeadless();
    try {
      emitter.emit("history.hydrate", {
        blocks: [
          {
            type: "tool_call",
            name: "edit_file",
            arguments: JSON.stringify({
              path: "src/x.ts",
              old_string: "const a = 1",
              new_string: "const a = 2",
            }),
            callId: "e1",
          },
        ],
        truncated: true,
      });
      const first = defined(streamRowAt(host.shell, 0));
      expect(first).toEqual(defined(host.shell.streamLog[0]));
      expect(isCollapsibleRow(first)).toBe(true);
      expect(host.shell.streamLogBase).toBe(0);
      expect(toggleRowExpandedAt(host.shell, 0)).toBe(true);
      expect(streamRowAt(host.shell, 0)?.expanded).toBe(true);
      expect(markerNotice(host.shell)).not.toMatch(/\b1 earlier row\b/);
    } finally {
      host.dispose();
    }
  });

  test("truncated hydrate in observe mode does not fake parentStreamLogBase", async () => {
    const { host, emitter } = await mountHeadless();
    try {
      enterSubagentObserve(host.shell, {
        sessionId: "child-trunc",
        agentId: "explorer",
        description: "observe truncated hydrate",
        lines: [],
      });
      emitter.emit("history.hydrate", {
        blocks: [{ type: "user", content: "kept parent" }],
        truncated: true,
      });
      expect(host.shell.parentStreamLogBase).toBe(0);
      expect(host.shell.parentUnloadedHistory).toBe(true);
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
      expect(host.shell.streamLog).toEqual([
        { role: "user", text: "fresh prompt" },
      ]);
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
    expect(() =>
      emitter.emit("event", { type: "user", text: "late" }),
    ).not.toThrow();
    expect(host.shell.streamLog).toEqual([]);
  });

  // Production holds finished rows for 4s; a short override keeps the
  // assertion (sticky poll clears the zone once linger expires, no
  // setChrome) identical without paying the full window in wall clock.
  const TEST_AGENTS_PANEL_LINGER_MS = 300;

  test("sticky ticks clear the agents zone after linger without setChrome", async () => {
    const now = Date.now();
    const { host, renderOnce, captureCharFrame, destroyHarness } =
      await mountHeadless({
        agentsPanelLingerMs: TEST_AGENTS_PANEL_LINGER_MS,
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

      // Only sticky poll may clear — no setChrome. Wait for the poll to clear
      // the zone once linger expires instead of a fixed linger + tick window.
      const deadline = Date.now() + TEST_AGENTS_PANEL_LINGER_MS + 1_500;
      while (Date.now() < deadline && host.shell.layout.heights.agents > 0) {
        await new Promise((r) => setTimeout(r, 50));
        await renderOnce();
      }
      expect(host.shell.layout.heights.agents).toBe(0);
      expect(captureCharFrame()).not.toContain("map callers");
    } finally {
      host.dispose();
      destroyHarness();
    }
  });

  test("host teardown drains a marked outstanding operator gate and clears its strip", async () => {
    const { host, emitter, destroyHarness } = await mountHeadless();
    try {
      let resolved: unknown = "unset";
      emitter.emit("operator.gate", {
        id: "ask-teardown",
        source: PRIMARY_ASK_OPERATOR_SOURCE,
        question: "Continue?",
        options: ["Yes", "No"],
        resolve: (result: unknown) => {
          resolved = result;
        },
      });
      expect(
        host.shell.operatorInputRequired.items.map((item) => item.id),
      ).toEqual(["ask-teardown"]);
      expect(host.shell.layout.heights.input_required).toBe(1);
      expect(emitter.listenerCount("operator.gate")).toBe(1);
      expect(emitter.listenerCount("permission.gate")).toBe(1);

      host.dispose();

      // The gate is drained by the teardown sweep, never left hanging.
      expect(resolved).toEqual({ kind: "cancel" });
      expect(host.shell.operatorInputRequired).toBe(NO_OPERATOR_INPUT_REQUIRED);
      expect(host.shell.layout.heights.input_required).toBe(0);
      expect(emitter.listenerCount("operator.gate")).toBe(0);
      expect(emitter.listenerCount("permission.gate")).toBe(0);
    } finally {
      destroyHarness();
    }
  });
});

describe("flat type-to-filter model picker", () => {
  // Several providers, one (codex) with three accounts, plus a favorite so the
  // top of the flat list has a reachable pick without typing.
  const providers = {
    "codex/acme-labs": { models: ["gpt-5.5", "gpt-5.6-sol"] },
    "codex/dirtroad": { models: ["gpt-5.5", "gpt-5.6-sol"] },
    "codex/fleur": { models: ["gpt-5.5", "gpt-5.6-sol"] },
    "xai/alice": { models: ["grok-4.5"] },
    "Z.AI": { models: ["glm-5", "glm-5-turbo", "glm-5.2"] },
  };

  async function mountPicker(
    overrides: Partial<ProductHostConfig> = {},
    options: {
      readonly height?: number;
      readonly favorites?: readonly { provider: string; model: string }[];
    } = {},
  ) {
    // One row taller than the usual fixture: on the landing screen (no
    // session content yet, which this fixture never sends) the version badge
    // reserves the terminal's last row, and this picker's row list needs
    // every row of the 24-row case to fit every provider.
    const harness = await createHarness({
      width: 80,
      height: options.height ?? 25,
    });
    const port = makeFakeSessionPort();
    const catalog = buildModelsFirstCatalog({
      providers,
      favorites: options.favorites ?? [
        { provider: "codex/acme-labs", model: "gpt-5.5" },
      ],
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
      expect(items.some((label) => label.includes("codex/acme-labs"))).toBe(
        true,
      );
      expect(items.some((label) => label.includes("xai/alice"))).toBe(true);
      // No provider-group-only rows (those were `providerGroup:` ids with no model).
      expect(
        items.every((label) => label.includes(" * [") || label.startsWith("(")),
      ).toBe(true);
      // Filter row is present so the list can narrow without another pane.
      expect(frame).toContain(">");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("typing narrows the flat list; accept applies the filtered row's own id", async () => {
    // Catalog order puts favorites/recents first; after filtering to "grok",
    // index 0 is the grok row — accepting must apply the grok id, never the
    // catalog's index-0 favorite.
    const { harness, host, selected } = await mountPicker();
    try {
      host.openModels?.();
      await harness.renderOnce();

      // Printable keys claimed by type-to-filter.
      await typeFilter(harness, "grok");

      const items = host.shell.overlayItems;
      expect(items.some((label) => label.includes("grok-4.5"))).toBe(true);
      expect(
        items.every(
          (label) => label.includes("grok") || label === "(no matches)",
        ),
      ).toBe(true);

      acceptOverlaySelection(host.shell);
      expect(selected).toEqual([modelOptionId("xai/alice", "grok-4.5")]);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("fits and scrolls within a short terminal instead of overflowing it", async () => {
    const { harness, host } = await mountPicker(
      { onModelSelect: () => undefined },
      { height: 10, favorites: [] },
    );
    try {
      host.openModels?.();
      await harness.renderOnce();
      const frame = harness.captureCharFrame();
      // Five provider rows do not all fit a 10-row terminal alongside the
      // overlay chrome; the picker renders without throwing and the frame
      // stays within the terminal's own line count.
      expect(frame.replace(/\n$/, "").split("\n").length).toBeLessThanOrEqual(
        10,
      );
      expect(host.shell.overlayList).not.toBeNull();
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("Enter on a no-matches filter does not apply a model", async () => {
    const { harness, host, selected } = await mountPicker();
    try {
      host.openModels?.();
      await harness.renderOnce();
      await typeFilter(harness, "zzzz-no-such-model");
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

  test("action keys on the no-matches sentinel toggle no favorite and set no default", async () => {
    const favorites: string[] = [];
    const defaults: string[] = [];
    const { harness, host } = await mountPicker({
      onFavoriteToggle: (id) => favorites.push(id),
      onSetDefault: (id) => defaults.push(id),
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      await typeFilter(harness, "zzzz-no-such-model");
      expect(host.shell.overlayItems).toEqual(["(no matches)"]);

      harness.pressKey("f", { meta: true });
      expect(runOverlayAction(host.shell, altD)).toBe(true);
      await harness.renderOnce();
      expect(favorites).toEqual([]);
      expect(defaults).toEqual([]);
      expect(host.shell.overlayKind).toBe("model_picker");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  const altD = {
    name: "d",
    ctrl: false,
    meta: false,
    option: true,
  } as KeyEvent;

  test("Alt+D on a focused row calls onSetDefault and leaves the picker open", async () => {
    const defaults: string[] = [];
    const { harness, host } = await mountPicker({
      onSetDefault: (id) => defaults.push(id),
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      expect(runOverlayAction(host.shell, altD)).toBe(true);
      expect(defaults).toEqual([modelOptionId("codex/acme-labs", "gpt-5.5")]);
      expect(host.shell.overlayKind).toBe("model_picker");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("composed Option+D (∂) sets the default instead of filtering the model picker", async () => {
    const defaults: string[] = [];
    const { harness, host } = await mountPicker({
      onSetDefault: (id) => defaults.push(id),
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      const composed = composedKey("∂");
      expect(handleListFilterKey(host.shell, composed)).toBe(false);
      expect(runOverlayAction(host.shell, composed)).toBe(true);
      expect(defaults).toEqual([modelOptionId("codex/acme-labs", "gpt-5.5")]);
      expect(host.shell.overlayItems).not.toEqual(["(no matches)"]);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("composed Option+D (∂) remains filter text when setting a default is unavailable", async () => {
    const { harness, host } = await mountPicker();
    try {
      host.openModels?.();
      await harness.renderOnce();
      const composed = composedKey("∂");
      expect(handleListFilterKey(host.shell, composed)).toBe(true);
      await harness.renderOnce();
      expect(host.shell.overlayItems).toEqual(["(no matches)"]);
      expect(runOverlayAction(host.shell, composed)).toBe(false);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("composed Option+D (∂) on the no-matches sentinel does not reach the prompt", async () => {
    const defaults: string[] = [];
    const { harness, host } = await mountPicker({
      onSetDefault: (id) => defaults.push(id),
    });
    try {
      host.shell.prompt.value = "draft";
      host.openModels?.();
      await harness.renderOnce();
      await typeFilter(harness, "zzzz-no-such-model");
      expect(host.shell.overlayItems).toEqual(["(no matches)"]);

      harness.pressKey("∂");
      await harness.renderOnce();

      expect(defaults).toEqual([]);
      expect(host.shell.prompt.value).toBe("draft");
      expect(host.shell.overlayKind).toBe("model_picker");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  const altR = {
    name: "r",
    ctrl: false,
    meta: false,
    option: true,
  } as KeyEvent;

  const REMOVE_WIRING = (removed: string[]) => ({
    onRemoveProvider: (id: string) => removed.push(id),
    describeRemoveProvider: (id: string): string | null =>
      id.length === 0
        ? null
        : `Remove provider for ${id}? Forgets catalog entry. Alt+R again to confirm, Esc cancels.`,
  });

  // Index 0 of the fixture catalog is the acme-labs favorite; index 1 is the
  // next surviving row of the same provider.
  const firstRowId = modelOptionId("codex/acme-labs", "gpt-5.5");
  const secondRowId = modelOptionId("codex/acme-labs", "gpt-5.6-sol");

  test("Alt+R arms the focused row with the blast-radius line and deletes nothing", async () => {
    const removed: string[] = [];
    const { harness, host } = await mountPicker(REMOVE_WIRING(removed));
    try {
      host.openModels?.();
      await harness.renderOnce();
      expect(runOverlayAction(host.shell, altR)).toBe(true);
      expect(removed).toEqual([]);
      expect(host.shell.overlayKind).toBe("model_picker");
      expect(host.shell.statusFlash).toContain("codex/acme-labs");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("Alt+R again on the armed row executes exactly once and clears the line", async () => {
    const removed: string[] = [];
    const { harness, host } = await mountPicker(REMOVE_WIRING(removed));
    try {
      host.openModels?.();
      await harness.renderOnce();
      expect(runOverlayAction(host.shell, altR)).toBe(true);
      expect(runOverlayAction(host.shell, altR)).toBe(true);
      expect(removed).toEqual([firstRowId]);
      expect(host.shell.statusFlash).toBeNull();
      expect(host.shell.overlayKind).toBe("model_picker");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("Alt+R on a different row re-arms instead of deleting", async () => {
    const removed: string[] = [];
    const { harness, host } = await mountPicker(REMOVE_WIRING(removed));
    try {
      host.openModels?.();
      await harness.renderOnce();
      expect(runOverlayAction(host.shell, altR)).toBe(true);
      moveOverlaySelection(host.shell, 1);
      await harness.renderOnce();
      expect(runOverlayAction(host.shell, altR)).toBe(true);
      expect(removed).toEqual([]);
      expect(host.shell.statusFlash).toContain("gpt-5.6-sol");
      // The re-arm belongs to the new row: confirming now deletes it, never
      // the row armed before the focus move.
      expect(runOverlayAction(host.shell, altR)).toBe(true);
      expect(removed).toEqual([secondRowId]);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("moving focus off the armed row disarms: coming back needs a fresh arm", async () => {
    const removed: string[] = [];
    const { harness, host } = await mountPicker(REMOVE_WIRING(removed));
    try {
      host.openModels?.();
      await harness.renderOnce();
      expect(runOverlayAction(host.shell, altR)).toBe(true);
      moveOverlaySelection(host.shell, 1);
      await harness.renderOnce();
      moveOverlaySelection(host.shell, -1);
      await harness.renderOnce();
      // Back on the first row, but the arm died with the focus move: this
      // press re-arms instead of executing.
      expect(runOverlayAction(host.shell, altR)).toBe(true);
      expect(removed).toEqual([]);
      expect(runOverlayAction(host.shell, altR)).toBe(true);
      expect(removed).toEqual([firstRowId]);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("Esc after arming closes disarmed with the line cleared", async () => {
    const removed: string[] = [];
    const { harness, host } = await mountPicker(REMOVE_WIRING(removed));
    try {
      host.openModels?.();
      await harness.renderOnce();
      expect(runOverlayAction(host.shell, altR)).toBe(true);
      expect(host.shell.statusFlash).not.toBeNull();
      harness.pressKey("Escape");
      await new Promise((r) => setTimeout(r, 30));
      await harness.renderOnce();
      expect(host.shell.overlayKind).toBeNull();
      expect(host.shell.statusFlash).toBeNull();
      // Reopening starts clean: Alt+R arms anew instead of executing.
      host.openModels?.();
      await harness.renderOnce();
      expect(runOverlayAction(host.shell, altR)).toBe(true);
      expect(removed).toEqual([]);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("Alt+R on the no-matches sentinel and ghost rows is inert", async () => {
    const removed: string[] = [];
    const grokId = modelOptionId("xai/alice", "grok-4.5");
    const { harness, host } = await mountPicker({
      onRemoveProvider: (id: string) => removed.push(id),
      // The xai row is a ghost: present in the picker but gone from settings.
      describeRemoveProvider: (id: string): string | null =>
        id === grokId || id.length === 0
          ? null
          : `Remove provider for ${id}? Forgets catalog entry. Alt+R again to confirm, Esc cancels.`,
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      await typeFilter(harness, "zzzz-no-such-model");
      expect(host.shell.overlayItems).toEqual(["(no matches)"]);
      expect(runOverlayAction(host.shell, altR)).toBe(false);
      expect(removed).toEqual([]);

      host.openModels?.();
      await harness.renderOnce();
      await typeFilter(harness, "grok");
      expect(runOverlayAction(host.shell, altR)).toBe(false);
      expect(removed).toEqual([]);
      expect(host.shell.statusFlash).toBeNull();
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("Alt+R is inert and unadvertised when removal is not wired", async () => {
    const { harness, host } = await mountPicker({
      onSetDefault: () => undefined,
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      expect(runOverlayAction(host.shell, altR)).toBe(false);
      expect(host.shell.statusFlash).toBeNull();
      expect(harness.captureCharFrame()).not.toContain("Alt+R");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("the footer advertises Alt+R only when removal is wired", async () => {
    const footer = async (
      overrides: Parameters<typeof mountPicker>[0],
    ): Promise<string> => {
      const mounted = await mountPicker(overrides);
      try {
        mounted.host.openModels?.();
        await mounted.harness.renderOnce();
        return mounted.harness.captureCharFrame();
      } finally {
        mounted.host.dispose();
        mounted.harness.destroy();
      }
    };

    const removed: string[] = [];
    expect(await footer(REMOVE_WIRING(removed))).toContain("Alt+R");
    expect(await footer({})).not.toContain("Alt+R");
  });

  test("bare r types into the filter; composed ® arms when wired and filters when not", async () => {
    const removed: string[] = [];
    const { harness, host } = await mountPicker(REMOVE_WIRING(removed));
    try {
      host.openModels?.();
      await harness.renderOnce();
      // Composed Option+R yields from the filter so the chord still works.
      const composed = composedKey("®");
      expect(handleListFilterKey(host.shell, composed)).toBe(false);
      expect(runOverlayAction(host.shell, composed)).toBe(true);
      expect(removed).toEqual([]);
      expect(host.shell.statusFlash).toContain("codex/acme-labs");
      // Bare `r` never reaches the action: the filter claims it (checked
      // last — claiming types the character and re-narrows the list).
      expect(
        handleListFilterKey(host.shell, {
          name: "r",
          sequence: "r",
          ctrl: false,
          meta: false,
          option: false,
        } as KeyEvent),
      ).toBe(true);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("composed ® remains filter text when removal is not wired", async () => {
    const { harness, host } = await mountPicker();
    try {
      host.openModels?.();
      await harness.renderOnce();
      const composed = composedKey("®");
      expect(handleListFilterKey(host.shell, composed)).toBe(true);
      expect(runOverlayAction(host.shell, composed)).toBe(false);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  const altA = {
    name: "a",
    ctrl: false,
    meta: false,
    option: true,
  } as KeyEvent;

  const ADD_PROVIDER_CHOICES = () => [
    { id: "codex", label: "Codex", hint: "", accountCount: 0 },
  ];

  test("the footer advertises only the keys whose handlers are wired", async () => {
    const footer = async (
      overrides: Parameters<typeof mountPicker>[0],
    ): Promise<string> => {
      const mounted = await mountPicker(overrides);
      try {
        mounted.host.openModels?.();
        await mounted.harness.renderOnce();
        return mounted.harness.captureCharFrame();
      } finally {
        mounted.host.dispose();
        mounted.harness.destroy();
      }
    };

    // Each hint rides iff its handler is wired — the footer only advertises
    // a key when that key actually works.
    expect(await footer({ onSetDefault: () => undefined })).toContain("Alt+D");
    const withProvider = await footer({
      onConnectProvider: () => undefined,
      addProviderChoices: ADD_PROVIDER_CHOICES,
    });
    expect(withProvider).toContain("Alt+A");
    expect(withProvider).toContain("/connect");
    const bare = await footer({});
    expect(bare).not.toContain("Alt+D");
    expect(bare).not.toContain("Alt+A");
  });

  test("Alt+A opens the add-provider selector listing every provider kind and its account count", async () => {
    const { harness, host } = await mountPicker({
      onConnectProvider: () => undefined,
      addProviderChoices: () => [
        {
          id: "codex",
          label: "Codex",
          hint: "ChatGPT subscription",
          accountCount: 2,
        },
        { id: "openai", label: "OpenAI", hint: "", accountCount: 0 },
        {
          id: "custom",
          label: "Custom",
          hint: "any OpenAI-compatible endpoint",
          accountCount: 0,
        },
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

  test("composed å through the key path opens add-provider", async () => {
    const { harness, host } = await mountPicker({
      onConnectProvider: () => undefined,
      addProviderChoices: ADD_PROVIDER_CHOICES,
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      harness.pressKey("å");
      await harness.renderOnce();
      expect(host.shell.overlayKind).toBe("add_provider");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("closed-prompt å stays in the prompt and does not open add-provider", async () => {
    const { harness, host } = await mountPicker({
      onConnectProvider: () => undefined,
      addProviderChoices: ADD_PROVIDER_CHOICES,
    });
    try {
      expect(host.shell.overlayKind).toBeNull();
      harness.pressKey("å");
      await harness.renderOnce();
      expect(host.shell.overlayKind).toBeNull();
      expect(host.shell.prompt.value).toContain("å");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("other composed glyphs still type-to-filter in the model picker", async () => {
    const { harness, host } = await mountPicker({
      onConnectProvider: () => undefined,
      addProviderChoices: ADD_PROVIDER_CHOICES,
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      for (const glyph of ["ø", "ä", "æ"] as const) {
        expect(handleListFilterKey(host.shell, composedKey(glyph))).toBe(true);
        expect(host.shell.overlayKind).toBe("model_picker");
      }
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("sequence-only å with name a opens add-provider from the model picker", async () => {
    // Terminals can report Option+A as sequence å while name stays ASCII a
    // and option/meta stay false (#482).
    const { harness, host } = await mountPicker({
      onConnectProvider: () => undefined,
      addProviderChoices: ADD_PROVIDER_CHOICES,
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      const sequenceOnly = {
        name: "a",
        sequence: "å",
        ctrl: false,
        meta: false,
        option: false,
      } as KeyEvent;
      expect(handleListFilterKey(host.shell, sequenceOnly)).toBe(false);
      expect(runOverlayAction(host.shell, sequenceOnly)).toBe(true);
      expect(host.shell.overlayKind).toBe("add_provider");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("composed å still type-to-filters when add-provider is not wired", async () => {
    const { harness, host } = await mountPicker();
    try {
      host.openModels?.();
      await harness.renderOnce();
      expect(handleListFilterKey(host.shell, composedKey("å"))).toBe(true);
      expect(host.shell.overlayKind).toBe("model_picker");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("bare ASCII a still type-to-filters when add-provider is wired", async () => {
    const { harness, host } = await mountPicker({
      onConnectProvider: () => undefined,
      addProviderChoices: ADD_PROVIDER_CHOICES,
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      expect(handleListFilterKey(host.shell, composedKey("a"))).toBe(true);
      expect(host.shell.overlayKind).toBe("model_picker");
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
      onConnectProvider: () => undefined,
      addProviderChoices: ADD_PROVIDER_CHOICES,
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      const modelItems = host.shell.overlayItems;
      runOverlayAction(host.shell, altA);
      await harness.renderOnce();
      expect(host.shell.overlayKind).toBe("add_provider");
      harness.pressKey("Escape");
      await new Promise((r) => setTimeout(r, 30));
      await harness.renderOnce();
      expect(host.shell.overlayKind).toBe("model_picker");
      expect(host.shell.overlayItems).toEqual(modelItems);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("Esc after openAddProvider from a closed prompt does not reopen the model list", async () => {
    const { harness, host } = await mountPicker({
      onConnectProvider: () => undefined,
      addProviderChoices: ADD_PROVIDER_CHOICES,
    });
    try {
      expect(host.shell.overlayKind).toBeNull();
      host.openAddProvider?.();
      await harness.renderOnce();
      expect(host.shell.overlayKind).toBe("add_provider");
      harness.pressKey("Escape");
      await new Promise((r) => setTimeout(r, 30));
      await harness.renderOnce();
      expect(host.shell.overlayKind).not.toBe("model_picker");
      expect(host.shell.overlayKind).toBeNull();
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("scoped add-provider forwards completion with the reconnect request", async () => {
    const completed: boolean[] = [];
    let finish: ((connected: boolean) => void) | undefined;
    const { harness, host } = await mountPicker({
      onConnectProvider: (_name, req) => {
        expect(req?.kind).toBe("xai");
        expect(req?.profile).toBe("default-2");
        finish = req?.onComplete;
      },
      addProviderChoices: () => [
        { id: "openai", label: "OpenAI", hint: "", accountCount: 0 },
        { id: "xai", label: "xAI", hint: "", accountCount: 1 },
      ],
    });
    try {
      host.openAddProvider?.({
        initialKind: "xai",
        initialProfile: "default-2",
        onComplete: (connected) => completed.push(connected),
      });
      await harness.renderOnce();
      acceptOverlaySelection(host.shell);
      finish?.(true);
      expect(completed).toEqual([true]);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("typed /connect then Enter opens add-provider and Esc leaves overlay null", async () => {
    const queued: { open?: () => void } = {};
    const { harness, host } = await mountPicker({
      onConnectProvider: () => undefined,
      addProviderChoices: ADD_PROVIDER_CHOICES,
      commands: [
        {
          id: "connect",
          label: "/connect",
          description: "Add a provider account",
          keywords: ["connect", "Add a provider account", "slash", "command"],
        },
      ],
      onCommand: (name) => {
        if (name === "connect") queued.open?.();
      },
    });
    queued.open = () => host.openAddProvider?.();
    try {
      expect(host.shell.overlayKind).toBeNull();
      for (const ch of "/connect") harness.pressKey(ch);
      await harness.renderOnce();
      harness.pressKey("Enter");
      await harness.renderOnce();
      expect(host.shell.overlayKind).toBe("add_provider");
      harness.pressKey("Escape");
      await new Promise((r) => setTimeout(r, 30));
      await harness.renderOnce();
      expect(host.shell.overlayKind).toBeNull();
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("without addProviderChoices the surface is absent and Alt+A is not claimed", async () => {
    const { harness, host } = await mountPicker();
    try {
      expect(host.openAddProvider).toBeUndefined();
      host.openModels?.();
      await harness.renderOnce();
      expect(runOverlayAction(host.shell, altA)).toBe(false);
      expect(host.shell.overlayKind).toBe("model_picker");
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("openModels(focusId) preselects the given row instead of the top of the list", async () => {
    const { harness, host } = await mountPicker();
    try {
      host.openModels?.(modelOptionId("codex/acme-labs", "gpt-5.6-sol"));
      await harness.renderOnce();
      const idx = host.shell.overlayItems.findIndex((label) =>
        label.includes("gpt-5.6-sol"),
      );
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(host.shell.overlayList?.activeIndex).toBe(idx);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("setModels on an open picker shows a newly catalogued model id", async () => {
    const { harness, host } = await mountPicker();
    try {
      host.openModels?.();
      await harness.renderOnce();
      expect(
        host.shell.overlayItems.some((label) => label.includes("live-1")),
      ).toBe(false);

      host.setModels?.([
        {
          id: modelOptionId("codex/acme-labs", "gpt-5.5"),
          label: "gpt-5.5 * [codex/acme-labs]",
        },
        {
          id: modelOptionId("opencode-go", "live-1"),
          label: "live-1 * [opencode-go]",
        },
      ]);
      await harness.renderOnce();

      expect(host.shell.overlayKind).toBe("model_picker");
      expect(
        host.shell.overlayItems.some((label) => label.includes("live-1")),
      ).toBe(true);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("setModels keeps the focused row by id across the catalog swap", async () => {
    const { harness, host } = await mountPicker();
    try {
      host.openModels?.();
      await harness.renderOnce();
      const grokIndex = host.shell.overlayItems.findIndex((label) =>
        label.includes("grok-4.5"),
      );
      expect(grokIndex).toBeGreaterThanOrEqual(0);
      moveOverlaySelection(host.shell, grokIndex);
      expect(host.shell.overlayList?.activeIndex).toBe(grokIndex);

      host.setModels?.([
        {
          id: modelOptionId("opencode-go", "live-1"),
          label: "live-1 * [opencode-go]",
        },
        {
          id: modelOptionId("xai/alice", "grok-4.5"),
          label: "grok-4.5 * [xai/alice]",
        },
        {
          id: modelOptionId("opencode-go", "live-2"),
          label: "live-2 * [opencode-go]",
        },
      ]);
      await harness.renderOnce();

      const next = host.shell.overlayItems.findIndex((label) =>
        label.includes("grok-4.5"),
      );
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).not.toBe(grokIndex);
      expect(host.shell.overlayList?.activeIndex).toBe(next);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("setModels does not steal an open add-provider overlay", async () => {
    const { harness, host } = await mountPicker({
      onConnectProvider: () => undefined,
      addProviderChoices: ADD_PROVIDER_CHOICES,
    });
    try {
      host.openModels?.();
      await harness.renderOnce();
      runOverlayAction(host.shell, altA);
      await harness.renderOnce();
      expect(host.shell.overlayKind).toBe("add_provider");

      host.setModels?.([
        {
          id: modelOptionId("opencode-go", "live-1"),
          label: "live-1 * [opencode-go]",
        },
      ]);
      await harness.renderOnce();

      expect(host.shell.overlayKind).toBe("add_provider");
      expect(host.shell.overlayItems).toEqual(["Codex — 0 accounts"]);
    } finally {
      host.dispose();
      harness.destroy();
    }
  });

  test("setModels re-applies the type-to-filter query against the new catalog", async () => {
    const { harness, host } = await mountPicker();
    try {
      host.openModels?.();
      await harness.renderOnce();
      await typeFilter(harness, "grok");
      expect(
        host.shell.overlayItems.every((label) => label.includes("grok")),
      ).toBe(true);

      host.setModels?.([
        {
          id: modelOptionId("xai/alice", "grok-4.5"),
          label: "grok-4.5 * [xai/alice]",
        },
        {
          id: modelOptionId("opencode-go", "grok-live"),
          label: "grok-live * [opencode-go]",
        },
        {
          id: modelOptionId("opencode-go", "live-1"),
          label: "live-1 * [opencode-go]",
        },
      ]);
      await harness.renderOnce();

      expect(host.shell.overlayKind).toBe("model_picker");
      expect(
        host.shell.overlayItems.some((label) => label.includes("grok-4.5")),
      ).toBe(true);
      expect(
        host.shell.overlayItems.some((label) => label.includes("grok-live")),
      ).toBe(true);
      expect(
        host.shell.overlayItems.some((label) => label.includes("live-1")),
      ).toBe(false);

      for (let i = 0; i < 4; i++) {
        harness.pressKey("Backspace");
      }
      await harness.renderOnce();
      expect(
        host.shell.overlayItems.some((label) => label.includes("live-1")),
      ).toBe(true);
      expect(
        host.shell.overlayItems.some((label) => label.includes("glm")),
      ).toBe(false);

      await typeFilter(harness, "glm");
      expect(host.shell.overlayItems).toEqual(["(no matches)"]);
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

describe("decideRemoveKey", () => {
  const row = 'model:["xai","grok-4"]';
  const other = 'model:["openai","gpt-5"]';

  test("ghost rows and the empty filter sentinel are inert", () => {
    expect(decideRemoveKey(null, row, false, 1000)).toBe("inert");
    expect(decideRemoveKey(null, "", true, 1000)).toBe("inert");
    expect(
      decideRemoveKey({ itemId: row, armedAt: 1000 }, row, false, 1001),
    ).toBe("inert");
  });

  test("first press arms; second press on the same row confirms", () => {
    expect(decideRemoveKey(null, row, true, 1000)).toBe("armed");
    expect(
      decideRemoveKey({ itemId: row, armedAt: 1000 }, row, true, 1000),
    ).toBe("confirmed");
    expect(
      decideRemoveKey(
        { itemId: row, armedAt: 1000 },
        row,
        true,
        1000 + REMOVE_ARM_MS - 1,
      ),
    ).toBe("confirmed");
  });

  test("an expired arm re-arms instead of executing", () => {
    expect(
      decideRemoveKey(
        { itemId: row, armedAt: 1000 },
        row,
        true,
        1000 + REMOVE_ARM_MS,
      ),
    ).toBe("armed");
    expect(
      decideRemoveKey(
        { itemId: row, armedAt: 1000 },
        row,
        true,
        1000 + REMOVE_ARM_MS + 60_000,
      ),
    ).toBe("armed");
  });

  test("a press on a different row re-arms instead of executing", () => {
    expect(
      decideRemoveKey({ itemId: row, armedAt: 1000 }, other, true, 1001),
    ).toBe("armed");
  });
});
