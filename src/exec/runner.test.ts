import { describe, expect, spyOn, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";
import type { AgentTool } from "@intx/agent";
import { submitOutputDefinition } from "../agent/director.js";
import { DIRECTOR_REGISTRY } from "../agent/directors/registry.js";
import {
  BUILD_TOOLS,
  DISPATCH_TOOLS,
  REVIEW_TOOLS,
} from "../agent/directors/tool-sets.js";
import {
  advertisedToolNamesForSessionMode,
  createToolIndex,
  createToolSearchTool,
} from "../agent/tool-search.js";
import {
  CodexAuthError,
  codexAuthFailureDiagnostic,
  CodexRefreshLockError,
} from "../auth/codex/session.js";
import type { Config } from "../config/index.js";
import { CREDENTIAL_FAILURE_USER_MESSAGE } from "../inference-error-message.js";
import { createPermissionGate } from "../permission/gate.js";
import {
  clearActiveRun,
  getActiveRun,
  setActiveRun,
} from "../session/active-run.js";
import { createAdvertisedToolset } from "../session/assemble-runtime.js";
import { loadState } from "../session/state.js";
import {
  withMockedHomedir,
  withMockedModuleDuring,
} from "../../testkit/mock-module.js";
import { createTempDirs } from "../../testkit/temporary-dirs.js";
import { createDynamicToolRunner } from "../agent/dynamic-tool-runner.js";
import { formatCaughtError } from "./dispose.js";
import {
  armExecMcpHandshakeAbort,
  awaitExecMcpConnect,
  awaitExecMcpThenResume,
  followExecMcpHandshake,
} from "./mcp-handshake.js";
import {
  createExecToolCallGate,
  createExecToolPromoter,
  execUserFailureMessage,
  isExecOverlayToolAllowed,
  refreshSelectedProviderCredential,
  resolveExecDirectorOverlay,
  resolveExecDirectorOverlayForPackage,
  resolveExecInteractive,
  runExec,
} from "./runner.js";

const OUTSIDE_ALLOW = "mcp__linear__create_issue";

function bareConfig(task: string): Config {
  // Minimal unconfigured-shaped object is not enough — runExec only needs
  // `task` for the empty-prompt early return before any bootstrap.
  return {
    command: "exec",
    task,
    cwd: process.cwd(),
    configured: true,
    providerName: "test",
    model: "test",
    providers: {},
    dangerouslySkipPermissions: true,
    autoMode: false,
    sessionId: "test-session",
  } as unknown as Config;
}

describe("exec director allowlist", () => {
  test("explorer overlay narrows advertised tools to the package allow list", () => {
    const overlay = resolveExecDirectorOverlay("explorer");
    expect(overlay.advertisedAllow).toBeDefined();
    expect(overlay.advertisedAllow).toContain("read_file");
    expect(overlay.advertisedAllow).toContain("run_shell");
    expect(overlay.advertisedAllow).not.toContain("tool_search");
    expect(overlay.advertisedAllow).not.toContain(OUTSIDE_ALLOW);
  });

  test("reviewer overlay narrows advertised tools to the package allow list", () => {
    const overlay = resolveExecDirectorOverlay("reviewer");
    expect(overlay.advertisedAllow).toBeDefined();
    expect(overlay.advertisedAllow).not.toContain("tool_search");
    expect(overlay.advertisedAllow).not.toContain(OUTSIDE_ALLOW);
  });

  test("dispatch keeps the product default — no allow list", () => {
    const overlay = resolveExecDirectorOverlay("dispatch");
    expect(overlay.advertisedAllow).toBeUndefined();
    expect(overlay.mountFleet).toBe(true);
  });

  test("deny entries are subtracted from the allow list", () => {
    const pkg = {
      ...DIRECTOR_REGISTRY.explorer,
      tools: { allow: ["read_file", "run_shell"], deny: ["run_shell"] },
    };
    expect(resolveExecDirectorOverlayForPackage(pkg).advertisedAllow).toEqual([
      "read_file",
    ]);
  });

  test("an allow that deny empties is rejected loudly", () => {
    const pkg = {
      ...DIRECTOR_REGISTRY.explorer,
      tools: { allow: ["run_shell"], deny: ["run_shell"] },
    };
    expect(() => resolveExecDirectorOverlayForPackage(pkg)).toThrow(/empty/);
  });

  test("a deny-only package config is rejected loudly", () => {
    const pkg = {
      ...DIRECTOR_REGISTRY.explorer,
      tools: { deny: ["run_shell"] },
    };
    expect(() => resolveExecDirectorOverlayForPackage(pkg)).toThrow(/deny/);
  });

  test("promote cannot make an outside-allow tool callable under explorer", () => {
    const overlay = resolveExecDirectorOverlay("explorer");
    expect(isExecOverlayToolAllowed(overlay, OUTSIDE_ALLOW)).toBe(false);
    const { activated, isAdvertised } = createAdvertisedToolset({
      sessionMode: "orchestrator",
      toolAvailability: { languageServerAvailable: true },
      getProvider: () => ({ providerName: "test", model: "test-model" }),
      builtInPrefix: overlay.advertisedAllow,
    });
    const promote = createExecToolPromoter({
      activate: (names) => activated.activate(names),
      isAllowed: (name) => isExecOverlayToolAllowed(overlay, name),
    });
    promote([OUTSIDE_ALLOW]);
    expect(activated.has(OUTSIDE_ALLOW)).toBe(false);
    expect(isAdvertised(OUTSIDE_ALLOW)).toBe(false);
    expect(createExecToolCallGate(isAdvertised)(OUTSIDE_ALLOW)).toBe(false);
  });

  test("the promoter commits allowed names onto the next infer wire", () => {
    const overlay = resolveExecDirectorOverlay("explorer");
    const { activated, computeAdvertised, flushPromotions } =
      createAdvertisedToolset({
        sessionMode: "orchestrator",
        toolAvailability: { languageServerAvailable: true },
        getProvider: () => ({ providerName: "test", model: "test-model" }),
        builtInPrefix: overlay.advertisedAllow,
      });
    let committed = 0;
    const promote = createExecToolPromoter({
      activate: (names) => activated.activate(names),
      isAllowed: (name) => isExecOverlayToolAllowed(overlay, name),
      commitWire: () => {
        if (flushPromotions()) committed += 1;
      },
    });
    const registry = [
      {
        name: "read_file",
        description: "read a file",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    promote([OUTSIDE_ALLOW, "read_file"]);
    expect(activated.has(OUTSIDE_ALLOW)).toBe(false);
    expect(activated.has("read_file")).toBe(true);
    expect(committed).toBe(1);
    expect(computeAdvertised(registry).map((d) => d.name)).toContain("read");
  });

  test("the promoter does not commit a name outside the overlay allow list", () => {
    const overlay = resolveExecDirectorOverlay("explorer");
    const { activated, computeAdvertised, flushPromotions } =
      createAdvertisedToolset({
        sessionMode: "orchestrator",
        toolAvailability: { languageServerAvailable: true },
        getProvider: () => ({ providerName: "test", model: "test-model" }),
        builtInPrefix: overlay.advertisedAllow,
      });
    let committed = 0;
    const promote = createExecToolPromoter({
      activate: (names) => activated.activate(names),
      isAllowed: (name) => isExecOverlayToolAllowed(overlay, name),
      commitWire: () => {
        if (flushPromotions()) committed += 1;
      },
    });
    const registry = [
      {
        name: OUTSIDE_ALLOW,
        description: "create an issue",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "lsp",
        description: "language server",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    promote([OUTSIDE_ALLOW]);
    expect(activated.has(OUTSIDE_ALLOW)).toBe(false);
    expect(committed).toBe(0);
    expect(computeAdvertised(registry).map((d) => d.name)).not.toContain(
      OUTSIDE_ALLOW,
    );
  });

  test("the promoter still commits lsp when the overlay allows it", () => {
    const overlay = resolveExecDirectorOverlay("explorer");
    expect(isExecOverlayToolAllowed(overlay, "lsp")).toBe(true);
    const { activated, computeAdvertised, flushPromotions } =
      createAdvertisedToolset({
        sessionMode: "orchestrator",
        toolAvailability: { languageServerAvailable: true },
        getProvider: () => ({ providerName: "test", model: "test-model" }),
        builtInPrefix: overlay.advertisedAllow,
      });
    let committed = 0;
    const promote = createExecToolPromoter({
      activate: (names) => activated.activate(names),
      isAllowed: (name) => isExecOverlayToolAllowed(overlay, name),
      commitWire: () => {
        if (flushPromotions()) committed += 1;
      },
    });
    const registry = [
      {
        name: "lsp",
        description: "language server",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: OUTSIDE_ALLOW,
        description: "create an issue",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    promote([OUTSIDE_ALLOW, "lsp"]);
    expect(activated.has(OUTSIDE_ALLOW)).toBe(false);
    expect(activated.has("lsp")).toBe(true);
    expect(committed).toBe(1);
    const names = computeAdvertised(registry).map((d) => d.name);
    expect(names).toContain("lsp");
    expect(names).not.toContain(OUTSIDE_ALLOW);
  });

  test("the promoter does not commit list_dir onto the advertised wire", () => {
    const { activated, computeAdvertised, flushPromotions } =
      createAdvertisedToolset({
        sessionMode: "orchestrator",
        toolAvailability: { languageServerAvailable: true },
        getProvider: () => ({ providerName: "test", model: "test-model" }),
      });
    let committed = 0;
    const promote = createExecToolPromoter({
      activate: (names) => activated.activate(names),
      isAllowed: () => true,
      commitWire: () => {
        if (flushPromotions()) committed += 1;
      },
    });
    const registry = [
      {
        name: "list_dir",
        description: "list a directory",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "mcp__acme__do",
        description: "do a thing",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    promote(["list_dir", "mcp__acme__do"]);
    expect(activated.has("list_dir")).toBe(false);
    expect(activated.has("mcp__acme__do")).toBe(true);
    expect(committed).toBe(1);
    const names = computeAdvertised(registry).map((d) => d.name);
    expect(names).not.toContain("list_dir");
    expect(names).toContain("mcp__acme__do");
  });

  test("dispatch overlay leaves every tool allowed", () => {
    const overlay = resolveExecDirectorOverlay("dispatch");
    expect(isExecOverlayToolAllowed(overlay, OUTSIDE_ALLOW)).toBe(true);
  });
});

describe("exec MCP connect bounds", () => {
  test("a hung handshake wait returns timeout without waiting for connect", async () => {
    const connecting = new Promise<void>(() => {
      // Never settles: hung MCP handshake.
    });
    const started = Date.now();
    const outcome = await awaitExecMcpConnect(connecting, 30);
    expect(outcome).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(250);
  });

  test("a settled handshake returns before the wait bound", async () => {
    const outcome = await awaitExecMcpConnect(Promise.resolve(), 1_000);
    expect(outcome).toBe("settled");
  });

  test("handshake abort fires while connect is still in flight", async () => {
    const handshake = armExecMcpHandshakeAbort(30);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(handshake.signal.aborted).toBe(true);
  });

  test("disarming after a successful handshake does not abort the live connection", async () => {
    const handshake = armExecMcpHandshakeAbort(30);
    handshake.disarm();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(handshake.signal.aborted).toBe(false);
  });

  test("a rejected batch leaves the abort timer armed while siblings stay in flight", async () => {
    const handshake = armExecMcpHandshakeAbort(40);
    const connecting = followExecMcpHandshake(
      Promise.reject(new Error("onStatus threw")),
      handshake,
    ).catch(() => undefined);
    await connecting;
    expect(handshake.signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(handshake.signal.aborted).toBe(true);
  });

  test("a fulfilled batch disarms so the abort cannot tear down the live connection", async () => {
    const handshake = armExecMcpHandshakeAbort(40);
    await followExecMcpHandshake(Promise.resolve(), handshake);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(handshake.signal.aborted).toBe(false);
  });

  test("resume waits for connect to settle even after the short wait times out", async () => {
    const handshake = armExecMcpHandshakeAbort(500);
    const events: string[] = [];
    const connecting = new Promise<void>((resolve) => {
      setTimeout(() => {
        events.push("settled");
        resolve();
      }, 50);
    });
    await awaitExecMcpThenResume(
      connecting.then(() => handshake.disarm()),
      async () => {
        events.push("resume");
      },
      { waitMs: 10, abort: handshake.signal },
    );
    expect(events).toEqual(["settled", "resume"]);
    handshake.disarm();
  });

  test("resume after a logged connect failure does not disarm the abort timer", async () => {
    const handshake = armExecMcpHandshakeAbort(40);
    let resumed = false;
    const connecting = followExecMcpHandshake(
      Promise.reject(new Error("filterServersForConnect failed")),
      handshake,
    ).catch(() => undefined);
    await awaitExecMcpThenResume(
      connecting,
      async () => {
        resumed = true;
      },
      { waitMs: 10, abort: handshake.signal },
    );
    expect(resumed).toBe(true);
    expect(handshake.signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(handshake.signal.aborted).toBe(true);
  });

  test("a hung connect resumes when the abort fires instead of waiting forever", async () => {
    const handshake = armExecMcpHandshakeAbort(40);
    const connecting = followExecMcpHandshake(
      new Promise<void>(() => {
        // Never settles: hung sibling handshake that ignores the signal.
      }),
      handshake,
    ).catch(() => undefined);
    const started = Date.now();
    let resumed = false;
    await awaitExecMcpThenResume(
      connecting,
      async () => {
        resumed = true;
      },
      { waitMs: 10, abort: handshake.signal },
    );
    expect(resumed).toBe(true);
    expect(handshake.signal.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(250);
  });
});

describe("exec credential failure surface", () => {
  test("raw codex auth errors map to the credential failure message", () => {
    const cfg = { inference: { timeoutMs: 1_000 } } as unknown as Config;
    // Raw auth error, no SELECTED wrapper and no provider failure observed:
    // still a credential failure, never the bare provider text.
    for (const auth of [
      new CodexAuthError(
        "personal",
        "refresh-failed",
        'Codex profile "personal" could not be refreshed (boom). Log in again.',
      ),
      new CodexAuthError(
        "ghost",
        "missing",
        'Codex profile "ghost" is missing. Log in again to recreate it.',
      ),
    ]) {
      expect(execUserFailureMessage(cfg, auth, false)).toBe(
        CREDENTIAL_FAILURE_USER_MESSAGE,
      );
    }
  });

  test("a codex refresh lock failure keeps its own message with the lock path", async () => {
    const cfg = { inference: { timeoutMs: 1_000 } } as unknown as Config;
    const lockPath = "/tmp/cl8628-codex-auth.refresh.lock";
    const lock = new CodexRefreshLockError(
      "personal",
      lockPath,
      `Timed out after 30000ms waiting for the Codex refresh lock at ${lockPath}.`,
    );
    // Joint surface with the combined classifier (#1138 rework is in flight
    // in parallel): the lock error never composes into credential_failure.
    expect(codexAuthFailureDiagnostic(lock)).toBeNull();
    // Raw pre-send failure: the exec layer repeats the lock message verbatim
    // instead of the generic re-login hint.
    const raw = execUserFailureMessage(cfg, lock, false);
    expect(raw).toContain(lockPath);
    expect(raw).not.toBe(CREDENTIAL_FAILURE_USER_MESSAGE);
    expect(raw).not.toMatch(/log in again/i);
    // First-inference refresh wraps failures in SELECTED_PROVIDER_FAILURE:
    // the lock path must survive that wrapper too.
    const wrapped = await refreshSelectedProviderCredential(() =>
      Promise.reject(lock),
    ).then(
      () => {
        throw new Error("expected the refresh to fail");
      },
      (err: unknown) => err,
    );
    const throughWrapper = execUserFailureMessage(cfg, wrapped, false);
    expect(throughWrapper).toContain(lockPath);
    expect(throughWrapper).not.toBe(CREDENTIAL_FAILURE_USER_MESSAGE);
  });
});

describe("selected provider refresh failures", () => {
  test("a non-provider failure remains distinct after inference has run", () => {
    expect(
      execUserFailureMessage(
        bareConfig("hello"),
        new Error("disk full"),
        false,
      ),
    ).toBe("disk full");
  });

  test("pre-inference OAuth failure keeps diagnostics internal and returns safe copy", async () => {
    const config = {
      ...bareConfig("hello"),
      providerName: "codex/work",
      settings: { providers: { "codex/work": { name: "Codex" } } },
    } as unknown as Config;
    const rawDiagnostic = '401 {"error":"refresh token rejected"}';

    try {
      await refreshSelectedProviderCredential(() =>
        Promise.reject(new Error(rawDiagnostic)),
      );
      throw new Error("expected refresh to fail");
    } catch (err) {
      expect(formatCaughtError(err)).toBe(rawDiagnostic);
      const userMessage = execUserFailureMessage(config, err, false);
      expect(userMessage).not.toContain(rawDiagnostic);
    }
  });
});

describe("runExec", () => {
  test("empty prompt exits 2 with stderr message without bootstrapping", async () => {
    const previous = getActiveRun();
    clearActiveRun();
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((
      chunk: string | Uint8Array,
      ...rest: unknown[]
    ) => {
      stderrChunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return origWrite(chunk as never, ...(rest as never[]));
    }) as typeof process.stderr.write;

    try {
      const result = await runExec(bareConfig("   "));
      expect(result.exitCode).toBe(2);
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/missing prompt|empty prompt/i);
      expect(stderrChunks.join("")).toMatch(
        /missing prompt|empty prompt|Usage: corbits exec/i,
      );
      expect(getActiveRun()).toBeNull();
    } finally {
      process.stderr.write = origWrite;
      if (previous !== null) setActiveRun(previous);
      else clearActiveRun();
    }
  });

  test("bootstrap throw after running write leaves terminal run.json and no active run", async () => {
    const previous = getActiveRun();
    clearActiveRun();
    const { cwd, home, cleanup } = createTempDirs(
      "corbits-exec-boot-cwd-",
      "corbits-exec-boot-home-",
    );
    const sessionId = "exec-bootstrap-fail";
    try {
      await withMockedHomedir(home, async () => {
        await withMockedModuleDuring(
          import.meta.resolve("../session/assemble-runtime.js"),
          (real: typeof import("../session/assemble-runtime.js")) => ({
            ...real,
            assembleInferenceBase: () =>
              Promise.reject(new Error("bootstrap failed")),
          }),
          async () => {
            const { runExec: runExecUnderMock } = await import("./runner.js");
            const result = await runExecUnderMock({
              ...bareConfig("do the thing"),
              cwd,
              sessionId,
            });
            expect(result.exitCode).toBe(1);
            expect(result.status).toBe("failed");
            const persisted = await loadState(cwd, sessionId, home);
            expect(persisted.kind).toBe("ok");
            if (persisted.kind !== "ok") return;
            expect(persisted.state.status).toBe("failed");
            expect(persisted.state.status).not.toBe("running");
            expect(persisted.state.finishedAt).toBeGreaterThan(0);
            expect(persisted.state.task).toBe("do the thing");
            expect(persisted.state.error).toBe("bootstrap failed");
            expect(getActiveRun()).toBeNull();
          },
        );
      });
    } finally {
      if (previous !== null) setActiveRun(previous);
      else clearActiveRun();
      cleanup();
    }
  });
});

describe("resolveExecDirectorOverlay", () => {
  test("coder exec primary does not mount fleet", () => {
    const overlay = resolveExecDirectorOverlay("coder");
    expect(overlay.mountFleet).toBe(false);
    expect(overlay.advertisedAllow).toBeDefined();
    expect(overlay.advertisedAllow).toEqual([...BUILD_TOOLS]);
    const buildToolSet = new Set<string>(BUILD_TOOLS);
    const fleetVerbs = DISPATCH_TOOLS.filter((name) => !buildToolSet.has(name));
    expect(fleetVerbs.length).toBeGreaterThan(0);
    for (const verb of fleetVerbs) {
      expect(overlay.advertisedAllow).not.toContain(verb);
    }
    expect(overlay.systemPrompt).toContain("Coder");
  });

  test("reviewer exec primary is a leaf overlay without fleet verbs", () => {
    const overlay = resolveExecDirectorOverlay("reviewer");
    expect(overlay.mountFleet).toBe(false);
    expect(overlay.advertisedAllow).toBeDefined();
    expect(overlay.advertisedAllow).toEqual([...REVIEW_TOOLS]);
    expect(overlay.advertisedAllow).not.toContain("spawn_agent");
    expect(overlay.advertisedAllow).not.toContain("wait_agents");
    expect(overlay.advertisedAllow).not.toContain("search_agents");
    expect(overlay.advertisedAllow).toContain("write_file");
    expect(overlay.systemPrompt).toContain("Reviewer");
  });

  test("dispatch default still can mount fleet", () => {
    expect(resolveExecDirectorOverlay(undefined).mountFleet).toBe(true);
    expect(resolveExecDirectorOverlay(undefined).systemPrompt).toBeUndefined();
    expect(
      resolveExecDirectorOverlay(undefined).advertisedAllow,
    ).toBeUndefined();
    expect(resolveExecDirectorOverlay("dispatch").mountFleet).toBe(true);
    expect(resolveExecDirectorOverlay("dispatch").systemPrompt).toBeUndefined();
  });
});

describe("exec advertised tools vs TUI", () => {
  const sessionMode = "orchestrator" as const;

  test("non-TTY exec advertised tools exclude ask_operator", () => {
    const overlay = resolveExecDirectorOverlay("dispatch");
    const names =
      overlay.advertisedAllow ??
      advertisedToolNamesForSessionMode(sessionMode, {
        languageServerAvailable: false,
        operatorAvailable: false,
      });
    expect(names).not.toContain("ask_operator");
    const { computeAdvertised } = createAdvertisedToolset({
      sessionMode,
      toolAvailability: {
        languageServerAvailable: false,
        operatorAvailable: false,
      },
      getProvider: () => ({ providerName: "test", model: "test" }),
    });
    expect(
      computeAdvertised([
        {
          name: "ask_operator",
          description: "ask",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "read_file",
          description: "read",
          inputSchema: { type: "object", properties: {} },
        },
      ]).map((d) => d.name),
    ).not.toContain("ask_operator");
  });

  test("TUI advertised tools still include ask_operator", () => {
    const names = advertisedToolNamesForSessionMode(sessionMode, {
      languageServerAvailable: false,
      operatorAvailable: true,
    });
    expect(names).toContain("ask_operator");
    const { isAdvertised } = createAdvertisedToolset({
      sessionMode,
      toolAvailability: {
        languageServerAvailable: false,
        operatorAvailable: true,
      },
      getProvider: () => ({ providerName: "test", model: "test" }),
    });
    expect(isAdvertised("ask_operator")).toBe(true);
  });
});

describe("exec tool call gate and promoter", () => {
  const stringTool = (
    name: string,
    reply: string,
    description: string,
  ): AgentTool => ({
    kind: "string",
    definition: {
      name,
      description,
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    handler: async () => reply,
  });

  function wireExecDiscovery() {
    const runner = createDynamicToolRunner([
      stringTool("read_file", "core", "read a file"),
      stringTool(
        "mcp__linear__save_issue",
        "saved",
        "Save an issue in the Linear tracker",
      ),
      stringTool(
        "present",
        "view",
        "search and render layout primitives for pages",
      ),
      stringTool("plugin__notes__save", "noted", "Save granola notes"),
      stringTool("list_dir", "listed", "list a directory's entries"),
      stringTool(submitOutputDefinition.name, "submitted", "submit output"),
    ]);
    const { activated, isAdvertised, computeAdvertised, flushPromotions } =
      createAdvertisedToolset({
        sessionMode: "orchestrator",
        toolAvailability: { languageServerAvailable: false },
        getProvider: () => ({ providerName: "test", model: "test" }),
      });
    runner.setCallGate(createExecToolCallGate(isAdvertised));
    let persistCount = 0;
    const promote = createExecToolPromoter({
      activate: (names) => activated.activate(names),
      isAllowed: () => true,
      persist: () => {
        persistCount += 1;
      },
      commitWire: () => {
        flushPromotions();
      },
    });
    runner.setOnUndeclaredCall((name) => promote([name]));
    const search = createToolSearchTool({
      search: (query) =>
        createToolIndex(() => runner.currentDefinitions()).search(query),
      lookup: (name) =>
        runner.currentDefinitions().find((d) => d.name === name),
      promote,
    });
    return {
      runner,
      persistCount: () => persistCount,
      computeAdvertised,
      flushPromotions,
      search,
    };
  }

  async function dispatch(
    runner: ReturnType<typeof createDynamicToolRunner>,
    name: string,
  ) {
    return runner.run(
      { id: name, name, arguments: {} },
      new AbortController().signal,
    );
  }

  test("search loads the top ranked MCP name onto the advertised tail", async () => {
    const { runner, search, persistCount, computeAdvertised } =
      wireExecDiscovery();
    const before = computeAdvertised(runner.currentDefinitions()).map(
      (d) => d.name,
    );
    expect(before).not.toContain("mcp__linear__save_issue");

    if (search.kind !== "string") throw new Error("expected string tool");
    await search.handler({ query: "linear" }, new AbortController().signal);
    expect(persistCount()).toBeGreaterThan(0);
    expect(
      computeAdvertised(runner.currentDefinitions()).map((d) => d.name),
    ).toContain("mcp__linear__save_issue");
  });

  test("search loads matching names onto the advertised tail without loading unrelated tools", async () => {
    const { runner, search, computeAdvertised } = wireExecDiscovery();
    if (search.kind !== "string") throw new Error("expected string tool");
    await search.handler({ query: "linear" }, new AbortController().signal);
    await search.handler(
      { query: "render layout" },
      new AbortController().signal,
    );
    const afterSearch = computeAdvertised(runner.currentDefinitions()).map(
      (d) => d.name,
    );
    expect(afterSearch).toContain("mcp__linear__save_issue");
    expect(afterSearch).toContain("present");
    expect(afterSearch).not.toContain("plugin__notes__save");
  });

  test("present and plugin names promote only the called name", async () => {
    const { runner, computeAdvertised } = wireExecDiscovery();
    expect((await dispatch(runner, "present")).content).toBe("view");
    expect(
      computeAdvertised(runner.currentDefinitions()).map((d) => d.name),
    ).toContain("present");
    expect(
      computeAdvertised(runner.currentDefinitions()).map((d) => d.name),
    ).not.toContain("plugin__notes__save");

    expect((await dispatch(runner, "plugin__notes__save")).content).toBe(
      "noted",
    );
  });

  test("gate admits submit_output without activation", async () => {
    const { runner } = wireExecDiscovery();
    const result = await dispatch(runner, submitOutputDefinition.name);
    expect(result.content).toBe("submitted");
    expect(result.isError).toBeUndefined();
  });

  test("executing list_dir does not add it to computeAdvertised", async () => {
    const { runner, computeAdvertised } = wireExecDiscovery();
    const before = computeAdvertised(runner.currentDefinitions()).map(
      (d) => d.name,
    );
    expect(before).not.toContain("list_dir");
    const result = await dispatch(runner, "list_dir");
    expect(result.content).toBe("listed");
    expect(result.isError).toBeUndefined();
    expect(
      computeAdvertised(runner.currentDefinitions()).map((d) => d.name),
    ).toEqual(before);
    expect(
      computeAdvertised(runner.currentDefinitions()).map((d) => d.name),
    ).not.toContain("list_dir");
  });
});

describe("exec permission prompt gating (CL-9002)", () => {
  test("piped stdout with a stdin TTY still prompts", () => {
    expect(resolveExecInteractive({ stdinTTY: true, stdoutTTY: false })).toBe(
      true,
    );
  });

  test("full TTY prompts", () => {
    expect(resolveExecInteractive({ stdinTTY: true, stdoutTTY: true })).toBe(
      true,
    );
  });

  test("headless stdin never prompts, whatever stdout is", () => {
    expect(resolveExecInteractive({ stdinTTY: false, stdoutTTY: false })).toBe(
      false,
    );
    expect(resolveExecInteractive({ stdinTTY: false, stdoutTTY: true })).toBe(
      false,
    );
    expect(
      resolveExecInteractive({ stdinTTY: undefined, stdoutTTY: true }),
    ).toBe(false);
  });

  // Exec-identical headless gate wiring: interactive:false with the prompt seam
  // armed to throw, so a test passes only when decide() denies on the real
  // production path (the old direct-seam test never went through decide()).
  const headlessGate = (onDeny: (reason: string) => void) =>
    createPermissionGate({
      approvals: [],
      requestApproval: async () => {
        throw new Error("headless run must never reach the prompt seam");
      },
      interactive: false,
      onHeadlessDeny: onDeny,
      skipPermissions: false,
      reactorGated: true,
    });

  const captureStdio = () => {
    const errWrites: string[] = [];
    const outWrites: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((
      chunk: unknown,
    ) => {
      errWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown,
    ) => {
      outWrites.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    return {
      errWrites,
      outWrites,
      restore: () => {
        stderrSpy.mockRestore();
        stdoutSpy.mockRestore();
      },
    };
  };

  test("headless gate deny names the action and remedy on stderr, stdout clean", async () => {
    const stdio = captureStdio();
    try {
      // Same shape as runner.ts: the denial surfaces on stderr, never stdout.
      const gate = headlessGate((reason) => {
        process.stderr.write(`Permission denied: ${reason}\n`);
      });
      const authorized = await gate.authorizeCall({
        id: "h1",
        name: "web_fetch",
        arguments: { url: "https://example.com/docs", format: "markdown" },
      } as ToolCall);
      expect(authorized.effect).toBe("deny");
      const evaluated = await gate.evaluate({
        id: "h2",
        name: "web_fetch",
        arguments: { url: "https://example.com/other", format: "markdown" },
      } as ToolCall);
      expect(evaluated.allowed).toBe(false);
    } finally {
      stdio.restore();
    }
    const denial = stdio.errWrites.join("");
    expect(denial).toContain("Permission denied:");
    expect(denial).toContain("requires operator approval");
    expect(denial).toContain("--dangerously-skip-permissions");
    expect(stdio.outWrites).toEqual([]);
  });

  test("secret-path headless deny names the action without bypass coaching", async () => {
    const stdio = captureStdio();
    try {
      const gate = headlessGate((reason) => {
        process.stderr.write(`Permission denied: ${reason}\n`);
      });
      const verdict = await gate.evaluate({
        id: "s1",
        name: "run_shell",
        arguments: { command: "cat .env" },
      } as ToolCall);
      expect(verdict.allowed).toBe(false);
    } finally {
      stdio.restore();
    }
    const denial = stdio.errWrites.join("");
    expect(denial).toContain("sensitive path");
    expect(denial).not.toContain("--dangerously-skip-permissions");
    expect(stdio.outWrites).toEqual([]);
  });

  test("piped stdout with a stdin TTY keeps the ask advertised and round-trips", async () => {
    expect(resolveExecInteractive({ stdinTTY: true, stdoutTTY: false })).toBe(
      true,
    );
    const seen: string[] = [];
    const gate = createPermissionGate({
      approvals: [],
      requestApproval: async (request) => {
        seen.push(request.subject);
        return { allow: true };
      },
      interactive: true,
      skipPermissions: false,
      reactorGated: true,
    });
    const call = {
      id: "i1",
      name: "web_fetch",
      arguments: { url: "https://example.com/docs", format: "markdown" },
    } as ToolCall;
    const authorized = await gate.authorizeCall(call);
    expect(authorized.effect).toBe("ask");
    expect(await gate.evaluate(call)).toEqual({ allowed: true });
    expect(seen).toEqual(["https://example.com/docs"]);
  });
});
