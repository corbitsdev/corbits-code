import { describe, expect, test } from "bun:test";
import type { Config } from "../../../src/config/index.js";
import {
  disposeExecRuntime,
  execUserFailureMessage,
  formatCaughtError,
  refreshSelectedProviderCredential,
  resolveExecDirectorOverlay,
  runExec,
} from "../../../src/exec/runner.js";
import { BUILD_TOOLS, SKYWALKER_TOOLS } from "../../../src/agent/directors/tool-sets.js";
import { createSubAgentSessionStore } from "../../../src/subagent/session-store.js";

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
    force: false,
    dangerouslySkipPermissions: true,
    autoMode: false,
    sessionId: "test-session",
  } as unknown as Config;
}

describe("formatCaughtError", () => {
  test("prefers Error.message and stringifies other values", () => {
    expect(formatCaughtError(new Error("disk full"))).toBe("disk full");
    expect(formatCaughtError("plain")).toBe("plain");
    expect(formatCaughtError(42)).toBe("42");
  });
});

describe("selected provider refresh failures", () => {
  test("a non-provider failure remains distinct after inference has run", () => {
    expect(execUserFailureMessage(bareConfig("hello"), new Error("disk full"), false)).toBe(
      "disk full",
    );
  });

  test("pre-inference OAuth failure keeps diagnostics internal and returns safe copy", async () => {
    const config = {
      ...bareConfig("hello"),
      providerName: "codex/work",
      settings: { providers: { "codex/work": { name: "Codex" } } },
    } as unknown as Config;
    const rawDiagnostic = '401 {"error":"refresh token rejected"}';

    try {
      await refreshSelectedProviderCredential(() => Promise.reject(new Error(rawDiagnostic)));
      throw new Error("expected refresh to fail");
    } catch (err) {
      expect(formatCaughtError(err)).toBe(rawDiagnostic);
      const userMessage = execUserFailureMessage(config, err, false);
      expect(userMessage).toBe("Authentication failed — log in again.");
      expect(userMessage).not.toContain(rawDiagnostic);
    }
  });

  test("terminal provider failures use the shared classified diagnostic", () => {
    const config = {
      ...bareConfig("hello"),
      providerName: "codex/work",
      settings: { providers: { "codex/work": { name: "Codex" } } },
    } as unknown as Config;

    expect(
      execUserFailureMessage(config, new Error("send failed"), true, {
        category: "protocol_mismatch",
        message: "\u001b[31mresponse\n shape changed\u001b[0m",
      }),
    ).toBe(
      'Codex Provider failed (protocol_mismatch): response shape changed. Switch models with "/model".',
    );
  });

  test("terminal provider failures prefer an explicit failing provider", () => {
    const config = {
      ...bareConfig("hello"),
      providerName: "openai",
      settings: { providers: { openai: { name: "OpenAI" } } },
    } as unknown as Config;

    expect(
      execUserFailureMessage(config, new Error("send failed"), true, {
        providerId: "xai/work",
        category: "credential_failure",
        message: "HTTP 401",
      }),
    ).toBe(
      "xai/work Provider failed (credential_failure): HTTP 401. Authentication failed — log in again.",
    );
  });
});

describe("runExec", () => {
  test("empty prompt exits 2 with stderr message without bootstrapping", async () => {
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return origWrite(chunk as never, ...(rest as never[]));
    }) as typeof process.stderr.write;

    try {
      const result = await runExec(bareConfig("   "));
      expect(result.exitCode).toBe(2);
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/missing prompt|empty prompt/i);
      expect(stderrChunks.join("")).toMatch(/missing prompt|empty prompt|Usage: corbits exec/i);
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

describe("disposeExecRuntime", () => {
  test("cancels fire-and-forget workers when exec finishes", async () => {
    const store = createSubAgentSessionStore();
    const worker = store.start({ description: "bg", agentId: "w", brief: "b" });
    let aborted = 0;
    store.registerCancel(worker.id, () => {
      aborted += 1;
    });

    const calls: string[] = [];
    await disposeExecRuntime({
      agent: {
        close: async () => {
          calls.push("agent");
        },
      },
      toolset: {
        dispose: async () => {
          calls.push("toolset");
        },
      },
      subAgentSessions: store,
    });

    expect(aborted).toBe(1);
    expect(store.get(worker.id)?.status).toBe("cancelled");
    expect(calls).toEqual(["agent", "toolset"]);
  });
});

describe("resolveExecDirectorOverlay", () => {
  test("builder exec primary does not mount fleet", () => {
    const overlay = resolveExecDirectorOverlay("builder");
    expect(overlay.mountFleet).toBe(false);
    expect(overlay.advertisedAllow).toBeDefined();
    expect(overlay.advertisedAllow).toEqual([...BUILD_TOOLS]);
    const buildToolSet = new Set<string>(BUILD_TOOLS);
    const fleetVerbs = SKYWALKER_TOOLS.filter((name) => !buildToolSet.has(name));
    expect(fleetVerbs.length).toBeGreaterThan(0);
    for (const verb of fleetVerbs) {
      expect(overlay.advertisedAllow).not.toContain(verb);
    }
    expect(overlay.systemPrompt).toContain("BuilderDirector");
  });

  test("skywalker default still can mount fleet", () => {
    expect(resolveExecDirectorOverlay(undefined).mountFleet).toBe(true);
    expect(resolveExecDirectorOverlay(undefined).systemPrompt).toBeUndefined();
    expect(resolveExecDirectorOverlay(undefined).advertisedAllow).toBeUndefined();
    expect(resolveExecDirectorOverlay("skywalker").mountFleet).toBe(true);
    expect(resolveExecDirectorOverlay("skywalker").systemPrompt).toBeUndefined();
  });
});
