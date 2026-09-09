import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupHarness, type RequestPredicate } from "@intx/inference-testing";
import { type } from "arktype";
import { createIsogitStore } from "@intx/storage-isogit/node";
import { ErrorRecord, type AuditRecord } from "@intx/types/audit";
import { createPermissionGate, type PermissionGate } from "../../src/permission/gate.js";
import {
  DENIED_BY_POLICY_MARKER,
  WORKER_CANNOT_COMPLETE_APPROVAL,
} from "../../src/permission/decline-markers.js";
import { runSubAgent, type RunSubAgentParams } from "../../src/subagent/run.js";
import { withMockedModuleDuring } from "../helpers/mock-module.js";
import { mcpClientToAgentTools } from "../../src/mcp/plugin.js";
import type { MCPClient } from "../../src/mcp/client.js";
import { getSubAgentIdentity } from "../../src/subagent/identity-context.js";
import { createSubAgentSessionStore } from "../../src/subagent/session-store.js";
import { workerPermissionGate } from "../../src/permission/reactor-authorize.js";
import { gateAgentTools } from "../../src/plugins/permission-plugin.js";

const report =
  "## Summary\nFinished.\n## Findings\nAttempted write.\n## Blockers\nNone.\n## Paths\nprobe.txt";
const RequestURL = type({ url: "string" });
const fromHost =
  (host: string): RequestPredicate =>
  (request) =>
    RequestURL.assert(request).url.includes(host);

async function withWorker(
  run: (ctx: {
    cwd: string;
    auditPath: string;
    harness: ReturnType<typeof setupHarness>;
    params: RunSubAgentParams;
    write: () => void;
    audit: () => Promise<AuditRecord[]>;
  }) => Promise<void>,
  gate?: (cwd: string) => PermissionGate,
) {
  const cwd = await mkdtemp(join(tmpdir(), "worker-permission-"));
  const harness = setupHarness();
  const workdirBase = join(cwd, "state");
  const auditPath = join(workdirBase, "subagents", "worker", "audit-store");
  const params: RunSubAgentParams = {
    id: "worker",
    cwd,
    workdirBase,
    description: "permission probe",
    prompt: "Write probe.txt then report.",
    provider: { providerName: "openai", baseURL: "https://api.openai.com/v1", model: "test-model" },
    permissionGate:
      gate?.(cwd) ??
      createPermissionGate({
        cwd,
        approvals: [],
        interactive: false,
        auto: false,
        skipPermissions: false,
        reactorGated: true,
      }),
  };
  try {
    await withMockedModuleDuring(
      import.meta.resolve("../../src/session/assemble-runtime.js"),
      (real: typeof import("../../src/session/assemble-runtime.js")) => ({
        ...real,
        assembleInferenceBase: async () => harness.deps,
      }),
      () =>
        run({
          cwd,
          auditPath,
          harness,
          params,
          write: () => {
            harness.scenario.replyOnce("openai", {
              toolCalls: [
                {
                  name: "write_file",
                  args: { path: join(cwd, "probe.txt"), content: "unauthorized" },
                },
              ],
            });
            harness.scenario.replyOnce("openai", { text: report });
          },
          audit: async () => {
            const store = await createIsogitStore(auditPath);
            const sessions = await readdir(join(auditPath, "state", "audit"));
            expect(sessions).toHaveLength(1);
            const session = sessions[0];
            if (session === undefined) throw new Error("missing runtime audit session");
            return store.loadAudit(session);
          },
        }),
    );
  } finally {
    harness.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}

for (const interactive of [false, true]) {
  test.serial(
    `worker denies unapproved write and persists audit (interactive=${interactive})`,
    async () => {
      let asks = 0;
      await withWorker(
        async ({ cwd, harness, params, write, audit }) => {
          write();
          await Promise.all([runSubAgent(params), harness.run({ wallClockBudgetMs: 15000 })]);
          expect(await Bun.file(join(cwd, "probe.txt")).exists()).toBe(false);
          expect(asks).toBe(0);
          const records = await audit();
          expect(records).toHaveLength(1);
          expect(records[0]).toMatchObject({
            tool: "write_file",
            arguments: {},
            authz: { effect: "deny", blocked: true },
            result: { isError: true },
          });
          expect(String(records[0]?.result.content)).toContain(DENIED_BY_POLICY_MARKER);
          if (interactive) {
            expect(String(records[0]?.result.content)).toContain("probe.txt");
            expect(String(records[0]?.result.content)).toContain(WORKER_CANNOT_COMPLETE_APPROVAL);
          }
          expect(records[0]?.callId.length).toBeGreaterThan(0);
          expect(records[0]?.sessionId.length).toBeGreaterThan(0);
        },
        (cwd) =>
          createPermissionGate({
            cwd,
            approvals: [],
            interactive,
            auto: false,
            skipPermissions: false,
            reactorGated: true,
            requestApproval: async () => {
              asks++;
              return { allow: true };
            },
          }),
      );
    },
    20000,
  );
}

test.serial(
  "retained worker checkpoints audit before close and observes live grants on resume",
  async () => {
    await withWorker(async ({ cwd, harness, params, write, audit }) => {
      let handles: Parameters<NonNullable<RunSubAgentParams["onAgentReady"]>>[0] | undefined;
      write();
      const [result] = await Promise.all([
        runSubAgent({
          ...params,
          persist: true,
          onAgentReady: (value) => {
            handles = value;
          },
        }),
        harness.run({ wallClockBudgetMs: 15000 }),
      ]);
      try {
        expect(result.agentRetained).toBe(true);
        expect((await audit())[0]?.authz?.effect).toBe("deny");
        if (handles === undefined) throw new Error("missing retained worker handles");
        params.permissionGate.setSeededApprovals([
          { tool: "write_file", pattern: join(cwd, "probe.txt") },
        ]);
        write();
        await Promise.all([
          handles.followup("Retry the write."),
          harness.run({ wallClockBudgetMs: 15000 }),
        ]);
        expect(await Bun.file(join(cwd, "probe.txt")).text()).toBe("unauthorized");
        const records = await audit();
        expect(records).toHaveLength(2);
        expect(records[1]).toMatchObject({
          tool: "write_file",
          authz: { effect: "allow", blocked: false },
          result: { isError: false },
        });
        params.permissionGate.setSeededApprovals([]);
        write();
        await Promise.all([
          handles.followup("Retry after revocation."),
          harness.run({ wallClockBudgetMs: 15000 }),
        ]);
        expect((await audit())[2]?.authz?.effect).toBe("deny");
      } finally {
        await handles?.close();
      }
      expect(await audit()).toHaveLength(3);
    });
  },
  20000,
);

async function loadErrors(auditPath: string) {
  // The vendored AuditStore exposes loadAudit but no error reader.
  const root = join(auditPath, "state", "errors");
  const sessions = await readdir(root);
  return (
    await Promise.all(
      sessions.map(async (session) => {
        const dir = join(root, session);
        return Promise.all(
          (await readdir(dir)).map(async (file) =>
            ErrorRecord.assert(await Bun.file(join(dir, file)).json()),
          ),
        );
      }),
    )
  ).flat();
}

test.serial(
  "nonmatching grant denies writes while read-only tools still execute",
  async () => {
    await withWorker(async ({ cwd, harness, params, audit }) => {
      await writeFile(join(cwd, "read.txt"), "read evidence");
      params.permissionGate.setSeededApprovals([
        { tool: "write_file", pattern: join(cwd, "other.txt") },
      ]);
      harness.scenario.replyOnce("openai", {
        toolCalls: [
          { name: "write_file", args: { path: join(cwd, "probe.txt"), content: "blocked" } },
          { name: "read_file", args: { path: join(cwd, "read.txt") } },
        ],
      });
      harness.scenario.replyOnce("openai", { text: report });
      await Promise.all([runSubAgent(params), harness.run({ wallClockBudgetMs: 15000 })]);
      expect(await Bun.file(join(cwd, "probe.txt")).exists()).toBe(false);
      const records = await audit();
      expect(records.find((record) => record.tool === "write_file")?.authz?.effect).toBe("deny");
      expect(records.find((record) => record.tool === "read_file")?.result.content).toContain(
        "read evidence",
      );
    });
  },
  20000,
);

test.serial(
  "worker owns MCP authorization with a middleware-gated parent",
  async () => {
    let asks = 0;
    await withWorker(
      async ({ harness, params, audit }) => {
        let calls = 0;
        const client = {
          serverName: "probe",
          tools: [
            {
              name: "mutate",
              description: "mutates",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          call: async () => {
            calls++;
            return "changed";
          },
          close: async () => undefined,
        };
        params.permissionGate.registerMcpClient(client);
        params.inheritMcpTools = (gate) => mcpClientToAgentTools(client, gate);
        harness.scenario.replyOnce("openai", {
          toolCalls: [{ name: "mcp__probe__mutate", args: {} }],
        });
        harness.scenario.replyOnce("openai", { text: report });
        await Promise.all([runSubAgent(params), harness.run({ wallClockBudgetMs: 15000 })]);
        expect(calls).toBe(0);
        expect(asks).toBe(0);
        expect((await audit())[0]?.authz?.effect).toBe("deny");
      },
      (cwd) =>
        createPermissionGate({
          cwd,
          approvals: [],
          interactive: true,
          auto: false,
          skipPermissions: false,
          reactorGated: false,
          requestApproval: async () => {
            asks++;
            return { allow: true };
          },
        }),
    );
  },
  20000,
);

test.serial(
  "allowed inherited MCP call with middleware-gated parent does not requestApproval",
  async () => {
    let asks = 0;
    await withWorker(
      async ({ harness, params, audit }) => {
        let calls = 0;
        const client = {
          serverName: "probe",
          tools: [
            {
              name: "mutate",
              description: "mutates",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          call: async () => {
            calls++;
            return "changed";
          },
          close: async () => undefined,
        };
        params.permissionGate.registerMcpClient(client);
        params.permissionGate.setSeededApprovals([
          { tool: "mcp__probe__mutate", pattern: "mcp__probe__mutate" },
        ]);
        const authorize = params.permissionGate.authorizeCall;
        params.permissionGate.authorizeCall = async (call) => {
          const result = await authorize(call);
          params.permissionGate.setSeededApprovals([]);
          return result;
        };
        params.inheritMcpTools = (gate) => mcpClientToAgentTools(client, gate);
        harness.scenario.replyOnce("openai", {
          toolCalls: [{ name: "mcp__probe__mutate", args: {} }],
        });
        harness.scenario.replyOnce("openai", { text: report });
        await Promise.all([runSubAgent(params), harness.run({ wallClockBudgetMs: 15000 })]);
        expect(calls).toBe(1);
        expect(asks).toBe(0);
        expect((await audit())[0]?.authz?.effect).toBe("allow");
      },
      (cwd) =>
        createPermissionGate({
          cwd,
          approvals: [],
          interactive: true,
          auto: false,
          skipPermissions: false,
          reactorGated: false,
          requestApproval: async () => {
            asks++;
            return { allow: true };
          },
        }),
    );
  },
  20000,
);

async function bindCreateAgentToolsetInherit(args: {
  cwd: string;
  permissionGate: PermissionGate;
  client: MCPClient;
}): Promise<{
  inheritMcpTools: NonNullable<RunSubAgentParams["inheritMcpTools"]>;
  dispose: () => Promise<void>;
}> {
  let inheritMcpTools: RunSubAgentParams["inheritMcpTools"];
  let dispose: () => Promise<void> = async () => undefined;
  await withMockedModuleDuring(
    import.meta.resolve("../../src/subagent/agent-fleet.js"),
    (real: typeof import("../../src/subagent/agent-fleet.js")) => ({
      ...real,
      createSpawnAgentTool: (deps: Parameters<typeof real.createSpawnAgentTool>[0]) => {
        inheritMcpTools = deps.inheritMcpTools;
        return real.createSpawnAgentTool(deps);
      },
    }),
    async () =>
      withMockedModuleDuring(
        import.meta.resolve("../../src/mcp/client.js"),
        (real: typeof import("../../src/mcp/client.js")) => ({
          ...real,
          connectMCPServer: async () => ({ ok: true as const, client: args.client }),
        }),
        async () => {
          const { createAgentToolset } = await import("../../src/agent/tools.js");
          const toolset = await createAgentToolset({
            cwd: args.cwd,
            permissionGate: args.permissionGate,
            onOperatorGate: async () => ({ kind: "cancel" }),
            mcpServers: [],
            subAgent: {
              provider: {
                providerName: "openai",
                baseURL: "https://api.openai.com/v1",
                model: "test-model",
              },
              getWorkdirBase: () => join(args.cwd, "state"),
              sessions: createSubAgentSessionStore(),
            },
          });
          dispose = () => toolset.dispose();
          await toolset.connectMCPServer(
            { name: "probe", type: "http", url: "https://mcp.probe.test/mcp" },
            {
              interactiveAuth: false,
              onStatus: () => undefined,
              onToolsChanged: () => undefined,
            },
          );
        },
      ),
  );
  if (inheritMcpTools === undefined) {
    await dispose();
    throw new Error("createAgentToolset did not wire inheritMcpTools");
  }
  return { inheritMcpTools, dispose };
}

test.serial(
  "createAgentToolset inherit wraps ungated MCP tools with the passed worker gate",
  async () => {
    let asks = 0;
    await withWorker(
      async ({ cwd, harness, params, audit }) => {
        let calls = 0;
        const client = {
          serverName: "probe",
          tools: [
            {
              name: "mutate",
              description: "mutates",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          call: async () => {
            calls++;
            return "changed";
          },
          close: async () => undefined,
        };
        const bound = await bindCreateAgentToolsetInherit({
          cwd,
          permissionGate: params.permissionGate,
          client,
        });
        try {
          params.permissionGate.setSeededApprovals([
            { tool: "mcp__probe__mutate", pattern: "mcp__probe__mutate" },
          ]);
          const authorize = params.permissionGate.authorizeCall;
          params.permissionGate.authorizeCall = async (call) => {
            const result = await authorize(call);
            params.permissionGate.setSeededApprovals([]);
            return result;
          };
          params.inheritMcpTools = bound.inheritMcpTools;
          harness.scenario.replyOnce("openai", {
            toolCalls: [{ name: "mcp__probe__mutate", args: {} }],
          });
          harness.scenario.replyOnce("openai", { text: report });
          await Promise.all([runSubAgent(params), harness.run({ wallClockBudgetMs: 15000 })]);
          expect(calls).toBe(1);
          expect(asks).toBe(0);
          expect((await audit())[0]?.authz?.effect).toBe("allow");
        } finally {
          await bound.dispose();
        }
      },
      (cwd) =>
        createPermissionGate({
          cwd,
          approvals: [],
          interactive: true,
          auto: false,
          skipPermissions: false,
          reactorGated: false,
          requestApproval: async () => {
            asks++;
            return { allow: true };
          },
        }),
    );
  },
  20000,
);

test("storing parent-gated MCP tools then wrapping again still calls requestApproval", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "worker-permission-"));
  let asks = 0;
  let calls = 0;
  try {
    const parent = createPermissionGate({
      cwd,
      approvals: [],
      interactive: true,
      auto: false,
      skipPermissions: false,
      reactorGated: false,
      requestApproval: async () => {
        asks++;
        return { allow: true };
      },
    });
    const client = {
      serverName: "probe",
      tools: [
        {
          name: "mutate",
          description: "mutates",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      call: async () => {
        calls++;
        return "changed";
      },
      close: async () => undefined,
    };
    parent.registerMcpClient(client);
    const parentGated = mcpClientToAgentTools(client, parent);
    const doubleWrapped = gateAgentTools(parentGated, workerPermissionGate(parent));
    const tool = doubleWrapped[0];
    if (tool?.kind !== "full") throw new Error("expected full inherited MCP tool");
    await tool.handler(
      { id: "c1", name: "mcp__probe__mutate", arguments: {} },
      new AbortController().signal,
    );
    expect(asks).toBe(1);
    expect(calls).toBe(1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test.serial(
  "live worker authorization is not evaluated again after policy revocation before runner",
  async () => {
    let asks = 0;
    await withWorker(
      async ({ cwd, harness, params, write, audit }) => {
        params.permissionGate.setAuto(true);
        const authorize = params.permissionGate.authorizeCall;
        let decisions = 0;
        params.permissionGate.authorizeCall = async (call) => {
          decisions++;
          const result = await authorize(call);
          params.permissionGate.setAuto(false);
          return result;
        };
        write();
        await Promise.all([runSubAgent(params), harness.run({ wallClockBudgetMs: 15000 })]);
        expect(await Bun.file(join(cwd, "probe.txt")).exists()).toBe(true);
        expect(decisions).toBe(1);
        expect(asks).toBe(0);
        expect((await audit())[0]?.authz?.effect).toBe("allow");
      },
      (cwd) =>
        createPermissionGate({
          cwd,
          approvals: [],
          interactive: true,
          auto: false,
          skipPermissions: false,
          reactorGated: false,
          requestApproval: async () => {
            asks++;
            return { allow: false };
          },
        }),
    );
  },
  20000,
);

test.serial(
  "concurrent real workers authorize under their own cwd on the shared gate",
  async () => {
    await withWorker(async ({ cwd, harness, params }) => {
      const cwds = [join(cwd, "first"), join(cwd, "second")];
      await Promise.all(cwds.map((dir) => mkdir(dir)));
      const seen: string[] = [];
      const authorize = params.permissionGate.authorizeCall;
      params.permissionGate.authorizeCall = async (call) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const identity = getSubAgentIdentity();
        if (identity === undefined) throw new Error("missing authorization identity");
        seen.push(identity.cwd);
        return authorize(call);
      };
      for (const dir of cwds) {
        const predicate = fromHost(dir.endsWith("first") ? "first.invalid" : "second.invalid");
        harness.scenario.replyOnce("openai", {
          predicate,
          toolCalls: [{ name: "write_file", args: { path: "probe.txt", content: "blocked" } }],
        });
        harness.scenario.replyOnce("openai", { predicate, text: report });
      }
      await Promise.all([
        ...cwds.map((dir, index) =>
          runSubAgent({
            ...params,
            id: `worker-${index}`,
            cwd: dir,
            provider: {
              ...params.provider,
              baseURL: `https://${index === 0 ? "first" : "second"}.invalid/v1`,
            },
          }),
        ),
        harness.run({ wallClockBudgetMs: 15000 }),
      ]);
      expect(seen.sort()).toEqual(cwds.sort());
      for (const dir of cwds) expect(await Bun.file(join(dir, "probe.txt")).exists()).toBe(false);
    });
  },
  20000,
);

test.serial(
  "worker persists inference failures through the agent error collector",
  async () => {
    await withWorker(async ({ harness, auditPath, params }) => {
      harness.scenario.replyOnce("openai", { text: "unauthorized", responseOpts: { status: 401 } });
      const results = await Promise.allSettled([
        runSubAgent(params),
        harness.run({ wallClockBudgetMs: 15000 }),
      ]);
      expect(results[0]?.status).toBe("rejected");
      const errors = await loadErrors(auditPath);
      expect(errors.some((error) => error.source === "inference" && error.statusCode === 401)).toBe(
        true,
      );
      expect(errors.every((error) => error.sessionId.length > 0)).toBe(true);
    });
  },
  20000,
);

test.serial(
  "nested dispatch inherits the same live permission gate",
  async () => {
    await withWorker(async ({ cwd, harness, params, audit }) => {
      const sessions = createSubAgentSessionStore();
      let handles: Parameters<NonNullable<RunSubAgentParams["onAgentReady"]>>[0] | undefined;
      params.permissionGate.setSeededApprovals([{ tool: "spawn_agent", pattern: "*" }]);
      const parent = fromHost("api.openai.com");
      const child = fromHost("nested.invalid");
      harness.scenario.replyOnce("openai", {
        predicate: parent,
        toolCalls: [
          {
            name: "spawn_agent",
            args: {
              description: "nested probe",
              prompt: "Write probe.txt then report.",
              intent: "implement",
              success_criteria: ["Report write result"],
            },
          },
        ],
      });
      harness.scenario.replyOnce("openai", { predicate: parent, text: report });
      harness.scenario.replyOnce("openai", {
        predicate: child,
        toolCalls: [
          { name: "write_file", args: { path: join(cwd, "probe.txt"), content: "unauthorized" } },
        ],
      });
      harness.scenario.replyOnce("openai", { predicate: child, text: report });
      try {
        await Promise.all([
          runSubAgent({
            ...params,
            persist: true,
            orchestrator: true,
            orchestratorTier: "nested-orchestrator",
            onAgentReady: (value) => {
              handles = value;
            },
            nestedDispatch: {
              permissionGate: params.permissionGate,
              sessions,
              useWorktree: false,
              getWorkdirBase: () => params.workdirBase,
              provider: { ...params.provider, baseURL: "https://nested.invalid/v1" },
            },
          }),
          harness.run({ wallClockBudgetMs: 15000 }),
        ]);
        for (
          let i = 0;
          i < 200 && sessions.list().some((session) => session.finishedAt === undefined);
          i++
        )
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect((await audit()).map((record) => record.result)).toEqual([
          { content: expect.anything(), isError: false },
        ]);
        expect(sessions.list()).toHaveLength(1);
        const nested = sessions.list()[0];
        if (nested === undefined) throw new Error("missing nested worker");
        expect(nested.finishedAt).toBeDefined();
        expect(await Bun.file(join(cwd, "probe.txt")).exists()).toBe(false);
        const auditPath = join(params.workdirBase, "subagents", nested.id, "audit-store");
        const store = await createIsogitStore(auditPath);
        const [sessionId] = await readdir(join(auditPath, "state", "audit"));
        if (sessionId === undefined) throw new Error("missing nested audit");
        expect((await store.loadAudit(sessionId))[0]?.authz?.effect).toBe("deny");
      } finally {
        sessions.cancelAll("test cleanup");
        await handles?.close();
      }
    });
  },
  20000,
);

test.serial(
  "runtime audit commit failure is observable after the tool side effect",
  async () => {
    await withWorker(async ({ cwd, harness, auditPath, params, write }) => {
      params.permissionGate.setAuto(true);
      write();
      const result = await Promise.allSettled([
        runSubAgent({
          ...params,
          extraToolPlugins: [
            {
              middleware: (next) => async (call, signal) => {
                await mkdir(join(auditPath, "state"), { recursive: true });
                await writeFile(join(auditPath, "state", "audit"), "block audit commit");
                return next(call, signal);
              },
            },
          ],
        }),
        harness.run({ wallClockBudgetMs: 15000 }),
      ]);
      expect(await Bun.file(join(cwd, "probe.txt")).text()).toBe("unauthorized");
      expect(result[0]?.status).toBe("fulfilled");
      expect(
        (await loadErrors(auditPath)).some(
          (error) => error.source === "reactor" && error.message.includes("afterCheckpoint failed"),
        ),
      ).toBe(true);
      await rm(join(auditPath, "state", "audit"));
      const store = await createIsogitStore(auditPath);
      const errors = await loadErrors(auditPath);
      const session = errors[0]?.sessionId;
      if (session === undefined) throw new Error("missing storage failure session");
      expect(await store.loadAudit(session)).toEqual([]);
    });
  },
  20000,
);

test.serial(
  "audit initialization failure prevents any worker tool side effect",
  async () => {
    await withWorker(async ({ cwd, auditPath, params, write }) => {
      await mkdir(join(auditPath, ".."), { recursive: true });
      await writeFile(auditPath, "not a directory");
      write();
      await expect(runSubAgent(params)).rejects.toThrow();
      expect(await Bun.file(join(cwd, "probe.txt")).exists()).toBe(false);
    });
  },
  20000,
);

for (const mode of [
  { interactive: true, auto: false },
  { interactive: false, auto: true },
] as const) {
  test.serial(
    `leaf worker submit_result succeeds with empty parent approvals (interactive=${mode.interactive} auto=${mode.auto})`,
    async () => {
      let asks = 0;
      await withWorker(
        async ({ harness, params, audit }) => {
          params.tier = "leaf";
          harness.scenario.replyOnce("openai", {
            toolCalls: [{ name: "submit_result", args: { turn_token: "stale", result: {} } }],
          });
          harness.scenario.replyOnce("openai", { text: report });
          await Promise.all([runSubAgent(params), harness.run({ wallClockBudgetMs: 15000 })]);
          expect(asks).toBe(0);
          const record = (await audit())[0];
          expect(record?.tool).toBe("submit_result");
          expect(record?.authz?.effect).toBe("allow");
          expect(record?.authz?.blocked).toBe(false);
          expect(String(record?.result.content)).toContain("turn_token");
        },
        (cwd) =>
          createPermissionGate({
            cwd,
            approvals: [],
            interactive: mode.interactive,
            auto: mode.auto,
            skipPermissions: false,
            reactorGated: mode.interactive,
            requestApproval: async () => {
              asks++;
              return { allow: true };
            },
          }),
      );
    },
    20000,
  );
}

test.serial(
  "leaf worker ask_director reaches the parent mailbox with empty parent approvals",
  async () => {
    let asks = 0;
    await withWorker(
      async ({ harness, params, audit }) => {
        params.tier = "leaf";
        let registered: { question: string; questionId: string } | undefined;
        params.askDirectorPort = {
          register: async (input) => {
            registered = input;
            return "src/foo.ts";
          },
          cancel: () => undefined,
        };
        harness.scenario.replyOnce("openai", {
          toolCalls: [{ name: "ask_director", args: { question: "which file?" } }],
        });
        harness.scenario.replyOnce("openai", { text: report });
        await Promise.all([runSubAgent(params), harness.run({ wallClockBudgetMs: 15000 })]);
        expect(asks).toBe(0);
        expect(registered?.question).toBe("which file?");
        expect((await audit())[0]).toMatchObject({
          tool: "ask_director",
          authz: { effect: "allow", blocked: false },
        });
      },
      (cwd) =>
        createPermissionGate({
          cwd,
          approvals: [],
          interactive: true,
          auto: false,
          skipPermissions: false,
          reactorGated: false,
          requestApproval: async () => {
            asks++;
            return { allow: true };
          },
        }),
    );
  },
  20000,
);

test.serial(
  "nested orchestrator wait_agents allows with only a spawn_agent grant",
  async () => {
    let asks = 0;
    await withWorker(
      async ({ cwd, harness, params, audit }) => {
        const sessions = createSubAgentSessionStore();
        let handles: Parameters<NonNullable<RunSubAgentParams["onAgentReady"]>>[0] | undefined;
        params.permissionGate.setSeededApprovals([{ tool: "spawn_agent", pattern: "*" }]);
        const parent = fromHost("api.openai.com");
        const child = fromHost("nested.invalid");
        harness.scenario.replyOnce("openai", {
          predicate: parent,
          toolCalls: [
            {
              name: "spawn_agent",
              args: {
                description: "nested probe",
                prompt: "Report only.",
                intent: "implement",
                success_criteria: ["Report"],
              },
            },
          ],
        });
        harness.scenario.replyOnce("openai", {
          predicate: parent,
          toolCalls: [{ name: "wait_agents", args: { timeout_ms: 8000 } }],
        });
        harness.scenario.replyOnce("openai", { predicate: parent, text: report });
        harness.scenario.replyOnce("openai", { predicate: child, text: report });
        try {
          await Promise.all([
            runSubAgent({
              ...params,
              persist: true,
              orchestrator: true,
              orchestratorTier: "nested-orchestrator",
              onAgentReady: (value) => {
                handles = value;
              },
              nestedDispatch: {
                permissionGate: params.permissionGate,
                sessions,
                useWorktree: false,
                getWorkdirBase: () => params.workdirBase,
                provider: { ...params.provider, baseURL: "https://nested.invalid/v1" },
              },
            }),
            harness.run({ wallClockBudgetMs: 15000 }),
          ]);
          expect(asks).toBe(0);
          expect(sessions.list()).toHaveLength(1);
          const records = await audit();
          expect(records.find((record) => record.tool === "wait_agents")?.authz?.effect).toBe(
            "allow",
          );
          expect(await Bun.file(join(cwd, "probe.txt")).exists()).toBe(false);
        } finally {
          sessions.cancelAll("test cleanup");
          await handles?.close();
        }
      },
      (cwd) =>
        createPermissionGate({
          cwd,
          approvals: [],
          interactive: true,
          auto: false,
          skipPermissions: false,
          reactorGated: false,
          requestApproval: async () => {
            asks++;
            return { allow: true };
          },
        }),
    );
  },
  20000,
);
