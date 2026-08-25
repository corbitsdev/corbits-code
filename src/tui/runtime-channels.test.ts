/**
 * Runtime side-channel wiring, asserted end to end.
 *
 * Every test here emits on the same emitter the session runner emits on and
 * then reads the painted frame. An emit with no listener is silent, and so is
 * a listener that paints nothing — only the frame tells those apart from a
 * working channel, which is the regression this file exists to catch.
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import { createHarness } from "./harness.js";
import { mountProductHost, type ProductHostConfig } from "./product-host.js";
import { isLanding } from "./shell.js";

async function mountHeadless(overrides: Partial<ProductHostConfig> = {}): Promise<{
  host: Awaited<ReturnType<typeof mountProductHost>>;
  emitter: EventEmitter;
  frame: () => Promise<string>;
  cleanup: () => void;
}> {
  const harness = await createHarness({ width: 100, height: 30 });
  const emitter = new EventEmitter();
  const host = await mountProductHost({
    title: "test-session",
    eventEmitter: emitter,
    send: () => {},
    interrupt: () => {},
    createRenderer: async () => harness.renderer,
    ...overrides,
  });
  return {
    host,
    emitter,
    frame: async () => {
      await harness.renderOnce();
      return harness.captureCharFrame();
    },
    cleanup: () => {
      host.dispose();
      harness.destroy();
    },
  };
}

const failingHook = {
  type: "hook.updated",
  hook: {
    id: "fmt",
    name: "format",
    type: "shell",
    path: "/hooks/format.sh",
    enabled: true,
    lastFiredAt: 1,
    lastKind: "postTurn",
    lastExitStatus: { code: 2, signal: null, stderr: "prettier not found" },
  },
};

describe("hook channel", () => {
  test("a failed hook lands in the transcript", async () => {
    const { emitter, frame, cleanup } = await mountHeadless();
    try {
      emitter.emit("hook", failingHook);
      expect(await frame()).toContain("hook format failed (exit 2)");
    } finally {
      cleanup();
    }
  });

  test("a clean hook run flashes on the notice row and holds no transcript row", async () => {
    const { host, emitter, frame, cleanup } = await mountHeadless();
    try {
      emitter.emit("hook", {
        ...failingHook,
        hook: {
          ...failingHook.hook,
          lastExitStatus: { code: 0, signal: null, stderr: "" },
        },
      });
      expect(await frame()).toContain("hook format ran");
      expect(host.shell.streamLog).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("startup inventory paints nothing", async () => {
    const { emitter, frame, cleanup } = await mountHeadless();
    try {
      emitter.emit("hook", { type: "hooks.loaded", hooks: [failingHook.hook] });
      expect(await frame()).not.toContain("format");
    } finally {
      cleanup();
    }
  });
});

describe("mcp.status channel", () => {
  test("a server awaiting authorization takes a prompt-box mark, not a transcript row", async () => {
    const { host, emitter, frame, cleanup } = await mountHeadless();
    try {
      emitter.emit("mcp.status", {
        name: "linear",
        state: "needs-auth",
        url: "https://mcp.test/auth",
      });
      const painted = await frame();
      expect(painted).toContain("mcp !");
      expect(painted).not.toContain("needs auth");
      expect(painted).not.toContain("https://mcp.test/auth");
      expect(host.shell.streamLog).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("connected clears the standing auth mark from state and the painted frame", async () => {
    const { host, emitter, frame, cleanup } = await mountHeadless();
    try {
      emitter.emit("mcp.status", { name: "linear", state: "needs-auth", url: "https://x/a" });
      expect(await frame()).toContain("mcp !");
      emitter.emit("mcp.status", { name: "linear", state: "connected", tools: ["a"] });
      const painted = await frame();
      expect(host.shell.mcpNeedsAuth).toEqual([]);
      expect(painted).not.toContain("mcp !");
    } finally {
      cleanup();
    }
  });

  test("a failed connect keeps the landing mountain and rides the notice strip (CL-5600)", async () => {
    // Full product-host path: mcp.status → mcpNotice → surfaceSystemNotice.
    // The unit landing suite covers surfaceSystemNotice alone; this locks the
    // wire so a future re-route through appendStreamRow cannot wipe the hero
    // again without failing here.
    const { host, emitter, frame, cleanup } = await mountHeadless();
    try {
      expect(isLanding(host.shell)).toBe(true);
      const before = await frame();
      const markBefore = before.split("\n").filter((row) => /[░▒▓█▁▂▃▄▅▆▇]/.test(row)).length;
      expect(markBefore).toBeGreaterThan(0);

      emitter.emit("mcp.status", {
        name: "linear",
        state: "failed",
        error: "ECONNREFUSED",
      });
      const painted = await frame();
      expect(painted).toContain("its tools are unavailable");
      expect(painted).toContain("mcp linear did not connect");
      // Still on landing: no transcript row, mountain still painted, wording on flash.
      expect(isLanding(host.shell)).toBe(true);
      expect(host.shell.streamLog).toEqual([]);
      expect(host.shell.statusFlash).toContain("mcp linear did not connect");
      const markAfter = painted.split("\n").filter((row) => /[░▒▓█▁▂▃▄▅▆▇]/.test(row)).length;
      expect(markAfter).toBe(markBefore);
    } finally {
      cleanup();
    }
  });

  test("connect chatter stays out of the transcript", async () => {
    const { host, emitter, frame, cleanup } = await mountHeadless();
    try {
      emitter.emit("mcp.status", { name: "linear", state: "connecting" });
      emitter.emit("mcp.status", { name: "linear", state: "connected", tools: ["a"] });
      expect(await frame()).toContain("mcp linear connected · 1 tool");
      expect(host.shell.streamLog).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("permission.grant channel", () => {
  test("a recorded grant is confirmed on the notice row", async () => {
    const { host, emitter, frame, cleanup } = await mountHeadless();
    try {
      emitter.emit("permission.grant", {
        approval: { tool: "run_shell", pattern: "git status" },
        covers: () => false,
      });
      const painted = await frame();
      expect(painted).toContain("granted run_shell git status");
      expect(painted).toContain("/permissions to revoke");
      expect(host.shell.streamLog).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("compaction channel", () => {
  test("a successful fold flashes before → after and holds no transcript row", async () => {
    const { host, emitter, frame, cleanup } = await mountHeadless();
    try {
      emitter.emit("compaction", { turnsBefore: 42, turnsAfter: 8 });
      const painted = await frame();
      expect(painted).toContain("context compacted · 42 → 8 turns");
      expect(host.shell.streamLog).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("a bad payload paints nothing", async () => {
    const { host, emitter, frame, cleanup } = await mountHeadless();
    try {
      emitter.emit("compaction", { turnsBefore: 42 });
      expect(await frame()).not.toContain("context compacted");
      expect(host.shell.streamLog).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("agents chrome (live strip above the prompt)", () => {
  test("setChrome with running agents paints the agents zone", async () => {
    const { host, frame, cleanup } = await mountHeadless({
      chrome: {
        agents: [
          {
            agentId: "explorer",
            description: "map callers",
            status: "running",
            currentToolName: "grep",
            currentToolStartedAt: null,
            startedAt: Date.now() - 5_000,
            lastActivityAt: Date.now(),
          },
        ],
      },
    });
    try {
      const painted = await frame();
      expect(painted).toContain("map callers");
      expect(painted).toContain("explorer");
      expect(host.shell.streamLog).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("a later chrome push paints the agents zone", async () => {
    const { host, frame, cleanup } = await mountHeadless();
    try {
      host.setChrome({
        agents: [
          {
            agentId: "explorer",
            description: "map callers",
            status: "running",
            currentToolName: "grep",
            currentToolStartedAt: null,
            startedAt: Date.now() - 5_000,
            lastActivityAt: Date.now(),
          },
        ],
      });
      const painted = await frame();
      expect(painted).toContain("map callers");
      expect(painted).toContain("explorer");
    } finally {
      cleanup();
    }
  });
});

/**
 * Static guard for the whole bug class: an emitted channel with no `.on`
 * anywhere is a feature nobody can see, and it fails silently. Static because
 * the subscribers are spread across the runner itself and the product host,
 * and only some of them exist at any one mount.
 *
 * `subagent.progress` is still emitted by the runner for external listeners,
 * but the product host no longer paints from it — tool state rides the
 * subagent store (`currentToolName` + clock) via setChrome. Drop it from the
 * "must have a .on somewhere" set so a deliberate non-subscriber is not a
 * false alarm.
 */
describe("every emitted runtime channel has a subscriber", () => {
  const srcDir = fileURLToPath(new URL("../", import.meta.url));
  const runner = readFileSync(`${srcDir}tui/runner.ts`, "utf8");

  const emitted = new Set([...runner.matchAll(/emitter\.emit\("([a-z.]+)"/g)].map((m) => m[1]!));
  // Progress pings are store-mirrored chrome, not a host paint path.
  emitted.delete("subagent.progress");

  test("the runner still emits the channels this suite knows about", () => {
    for (const channel of ["hook", "mcp.status", "permission.grant", "compaction"]) {
      expect([...emitted]).toContain(channel);
    }
  });

  test.each([...emitted])("%s is subscribed somewhere in src", async (channel) => {
    const grep = Bun.spawnSync(["grep", "-rl", `.on("${channel}"`, srcDir, "--include=*.ts"]);
    const files = new TextDecoder()
      .decode(grep.stdout)
      .split("\n")
      .filter((f) => f.length > 0 && !f.endsWith(".test.ts"));
    expect(files).not.toEqual([]);
  });
});
