import { join } from "node:path";
import { EventEmitter } from "node:events";
import { render } from "ink";
import {
  createAgent,
  defineAgent,
  defineTool,
  createDirectorRegistry,
  defineDirector,
  type Agent,
} from "@intx/agent";
import { noopAuditStore, permissiveAuthorize } from "@intx/agent/testing";
import { createIsogitStore } from "@intx/storage-isogit";
import { type } from "arktype";
import { buildOpenAISource, type Config } from "../config.js";
import type { PlanStep } from "./use-stream.js";
import { createChatDirector, type ApprovalGate } from "../director.js";
import { buildChatSystemPrompt } from "../prompts.js";
import { loadAgentContextExtensions } from "../run-agent.js";
import { createPermissionGate } from "../permission/gate.js";
import { createPermissionsAdmin } from "../permission/admin.js";
import { createAgentToolset } from "../agent-tools.js";
import {
  loadApprovals,
  loadProjectApprovals,
  loadGlobalApprovals,
  loadProviderModelApprovals,
  saveProjectApproval,
  saveGlobalApproval,
  saveProviderModelApproval,
} from "../permission/store.js";
import type { Approval, GrantScope } from "../permission/types.js";
import { consumeStream } from "../stream-consumer.js";
import { enterAltScreen } from "../alt-screen.js";
import { App } from "./app.js";
import type { OperatorGateEvent, PermissionGateEvent, PlanGateEvent } from "./hooks/use-gates.js";
import {
  createLifecycleHookManager,
  createRunSummary,
  discoverLifecycleHooks,
  hookDirectories,
  type RunSummary,
} from "../hooks.js";
import { createRunSink } from "../run-sink.js";
import { generateSessionId, initSessionDir, sessionContextDir, sessionDir } from "../session.js";

export function createTUIEventEmitter(): EventEmitter {
  return new EventEmitter();
}

export { getTUIRunSummaryStatus } from "../run-sink.js";

export type ResolveExitCodeArgs = {
  runError: string | undefined;
  sinkError: string | undefined;
  status: RunSummary["status"];
};

export function resolveExitCode(args: ResolveExitCodeArgs): number {
  const { runError, sinkError, status } = args;
  if (runError !== undefined || sinkError !== undefined || status !== "done") {
    return 1;
  }
  return 0;
}

export async function runTUI(config: Config): Promise<number> {
  let sessionId = config.sessionId;
  let workdir = sessionContextDir(config.cwd, sessionId);
  await initSessionDir(config.cwd, sessionId);
  const emitter = createTUIEventEmitter();
  const startedAt = Date.now();
  const hookManager = createLifecycleHookManager({
    hooks: await discoverLifecycleHooks(hookDirectories(config.cwd)),
    onEvent: (event) => emitter.emit("hook", event),
  });
  let runError: string | undefined;

  const recordRunError = (err: unknown): void => {
    runError = err instanceof Error ? err.message : String(err);
  };

  const approvalGate: ApprovalGate = (plan: PlanStep[]) => {
    return new Promise<boolean>((resolve) => {
      const event: PlanGateEvent = { plan, resolve };
      emitter.emit("plan.gate", event);
    });
  };

  const activeProviderModel = `${config.providerName}:${config.model}`;
  const sessionApprovals = await loadApprovals(config.cwd, sessionId);
  const [projectApprovals, globalApprovals, providerModelApprovals] = await Promise.all([
    loadProjectApprovals(config.cwd),
    loadGlobalApprovals(),
    loadProviderModelApprovals(),
  ]);
  const seededApprovals: Approval[] = [
    ...sessionApprovals,
    ...projectApprovals,
    ...globalApprovals,
    ...providerModelApprovals,
  ];
  const permissionGate = createPermissionGate({
    approvals: seededApprovals,
    cwd: config.cwd,
    providerName: config.providerName,
    model: config.model,
    requestApproval: (request) =>
      new Promise((resolve) => {
        const event: PermissionGateEvent = { request, resolve };
        emitter.emit("permission.gate", event);
      }),
    persist: (approval: Approval, scope: GrantScope) => {
      // Route each persisted grant to the store its scope selects. Session
      // grants never reach here — the gate keeps those in memory only.
      if (scope === "project") {
        void saveProjectApproval(config.cwd, approval);
      } else if (scope === "global") {
        void saveGlobalApproval(approval);
      } else if (scope === "provider-model") {
        void saveProviderModelApproval(activeProviderModel, approval);
      }
    },
    interactive: true,
    skipPermissions: config.dangerouslySkipPermissions,
    auto: config.auto,
  });

  const permissionsAdmin = createPermissionsAdmin(permissionGate, config.cwd);

  const toolset = await createAgentToolset({
    cwd: config.cwd,
    permissionGate,
    onOperatorGate: (question, options) =>
      new Promise<number>((resolve) => {
        const event: OperatorGateEvent = { question, options, resolve };
        emitter.emit("operator.gate", event);
      }),
    ...(config.mcpServers !== undefined ? { mcpServers: config.mcpServers } : {}),
    subAgent: {
      provider: {
        providerName: config.providerName,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
      },
      getWorkdirBase: () => sessionDir(config.cwd, sessionId),
    },
  });

  const agentExtensions = await loadAgentContextExtensions(config.cwd);
  const extensions = [...agentExtensions, ...(config.systemPromptExtensions ?? [])];
  const systemPrompt = buildChatSystemPrompt(extensions.length > 0 ? extensions : undefined);

  const directorHolder: { instance?: ReturnType<typeof createChatDirector> } = {};

  const chatDirectorDef = defineDirector({
    id: "interchange-code/chat",
    configSchema: type({}),
    factory: (_config, _env, agentCtx) => {
      const d = createChatDirector(
        agentCtx.systemPrompt,
        [...agentCtx.toolDefinitions],
        approvalGate,
      );
      directorHolder.instance = d;
      return d;
    },
  });

  const toolsFactory = defineTool({
    id: "interchange-code/tui-tools",
    factory: () => toolset.dynamicRunner,
  });

  const def = defineAgent({
    id: "interchange-code/tui-agent",
    systemPrompt,
    tools: [toolsFactory],
    capabilities: [],
    director: chatDirectorDef.build({}),
    inference: {
      sources: [{ provider: config.providerName, model: config.model }],
    },
  });

  // The agent freezes its tool-dispatch map at construction, so MCP servers that
  // connect after startup are not callable until the agent is rebuilt. buildAgent
  // re-runs tool resolution against the (now-populated) dynamic runner and resumes
  // conversation from the same git-backed store, so a reload is transparent.
  const buildAgent = async (): Promise<Agent> => {
    const storage = await createIsogitStore(workdir);
    return createAgent(def, {
      source: buildOpenAISource({
        id: config.providerName,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
      }),
      storage,
      workdir,
      audit: noopAuditStore(),
      authorize: permissiveAuthorize(),
      directors: createDirectorRegistry({ factories: [chatDirectorDef.factory], defaultId: "interchange-code/chat" }),
    });
  };

  const runSink = createRunSink({ emitter, hookManager });

  // Tool count before any MCP server connects; a reload is only worthwhile if
  // connecting actually added tools.
  const baseToolCount = toolset.dynamicRunner.currentDefinitions().length;

  let currentAgent = await buildAgent();
  let streamPromise = consumeStream(currentAgent.stream(), runSink.sink);

  // Reload coordination. A reload must close the old agent (releasing the
  // per-workdir lock) before opening the new one, so `send` is held behind
  // `reloadBarrier` during the swap, and a reload defers until no send is in
  // flight (so it never interrupts an active turn).
  let inFlight = 0;
  let pendingReload = false;
  let reloading = false;
  let reloadBarrier: Promise<void> | null = null;

  const reloadIfIdle = async (): Promise<void> => {
    if (!pendingReload || reloading || inFlight > 0) return;
    pendingReload = false;
    reloading = true;
    let release!: () => void;
    reloadBarrier = new Promise<void>((r) => (release = r));
    try {
      const old = currentAgent;
      await old.close().catch(() => undefined);
      await streamPromise.catch(() => undefined);
      currentAgent = await buildAgent();
      streamPromise = consumeStream(currentAgent.stream(), runSink.sink);
    } finally {
      reloading = false;
      reloadBarrier = null;
      release();
    }
  };

  // Stable handle handed to the App so the underlying agent can be swapped out
  // from under it without a remount; method calls always target the live agent.
  const agentProxy: Agent = {
    send: async (content, opts) => {
      if (reloadBarrier !== null) await reloadBarrier;
      inFlight++;
      try {
        return await currentAgent.send(content, opts);
      } finally {
        inFlight--;
        void reloadIfIdle();
      }
    },
    stream: () => currentAgent.stream(),
    deliver: (message) => currentAgent.deliver(message),
    close: () => currentAgent.close(),
    setSource: (source) => currentAgent.setSource(source),
    history: () => currentAgent.history(),
    checkpoints: (limit) => currentAgent.checkpoints(limit),
    readAt: (hash) => currentAgent.readAt(hash),
    get blobReader() {
      return currentAgent.blobReader;
    },
  };

  // A hard stop: closing the agent is the only thing that aborts the reactor
  // mid-inference (the send signal only rejects the send promise). Close it,
  // drain the old stream, and rebuild a fresh agent so the next send works.
  const interrupt = async (): Promise<void> => {
    if (reloading) return;
    reloading = true;
    let release!: () => void;
    reloadBarrier = new Promise<void>((r) => (release = r));
    try {
      await currentAgent.close().catch(() => undefined);
      await streamPromise.catch(() => undefined);
      currentAgent = await buildAgent();
      streamPromise = consumeStream(currentAgent.stream(), runSink.sink);
    } catch (err) {
      recordRunError(err);
    } finally {
      reloading = false;
      reloadBarrier = null;
      release();
    }
  };

  // /clear and /new start a fresh conversation: mint a new session id and its
  // own state directory, repoint the working tree at it, and rebuild the agent
  // so it resumes from an empty git-backed store. The prior session stays on
  // disk under its own id, resumable later. Sub-agents nest under the new
  // session automatically because getWorkdirBase reads the live id.
  const newSession = async (): Promise<void> => {
    // The App clears its transcript unconditionally on /clear, so the backend
    // rotation must not be skipped under contention or the UI and the live
    // store would desync. Wait for any in-flight reload/interrupt to settle,
    // then claim the swap.
    while (reloading && reloadBarrier !== null) await reloadBarrier;
    reloading = true;
    let release!: () => void;
    reloadBarrier = new Promise<void>((r) => (release = r));
    try {
      sessionId = generateSessionId();
      workdir = sessionContextDir(config.cwd, sessionId);
      await initSessionDir(config.cwd, sessionId);
      permissionGate.reset();
      await currentAgent.close().catch(() => undefined);
      await streamPromise.catch(() => undefined);
      currentAgent = await buildAgent();
      streamPromise = consumeStream(currentAgent.stream(), runSink.sink);
    } catch (err) {
      recordRunError(err);
    } finally {
      reloading = false;
      reloadBarrier = null;
      release();
    }
  };

  // Ink 7.0.4 has no enterAltScreen render option, so drive the alternate
  // screen buffer by hand: enter before render to hide pre-launch scrollback,
  // and restore it on exit (including abrupt process exit) so history returns.
  const exitAltScreen = enterAltScreen();

  // Render first so the App's gate listeners are registered before it sends the
  // initial task. exitOnCtrlC is off so Ctrl+C reaches our keymap (stop the run)
  // instead of Ink killing the process outright.
  const { waitUntilExit } = render(
    <App
      eventEmitter={emitter}
      agent={agentProxy}
      sessionTitle={config.task}
      initialModel={config.model}
      initialProvider={config.providerName}
      providers={config.providers}
      globalSettingsPath={config.globalSettingsPath}
      {...(config.globalDefaultProvider !== undefined ? { globalDefaultProvider: config.globalDefaultProvider } : {})}
      cwd={config.cwd}
      initialTask={config.task}
      initialHooks={hookManager.getStatuses()}
      onToggleHook={(hookId, enabled) => hookManager.setEnabled(hookId, enabled)}
      onAgentError={recordRunError}
      onInterrupt={() => { void interrupt(); }}
      onNewSession={() => { void newSession(); }}
      permissionsAdmin={permissionsAdmin}
      {...(config.profile !== undefined ? { profile: config.profile } : {})}
    />,
    { exitOnCtrlC: false },
  );

  // Connect MCP servers after the TUI is up so the UI is usable immediately and
  // any OAuth authorization is surfaced as a copyable link rather than a browser
  // pop. Newly discovered tools are advertised to the live director right away;
  // once connection resolves, the agent is reloaded (when idle) so the tools are
  // also dispatchable. Aborted on exit so an unfinished auth wait does not keep
  // the process alive.
  const mcpConnectController = new AbortController();
  void toolset
    .connectMCP(
      {
        onStatus: (status) => emitter.emit("mcp.status", status),
        onToolsChanged: (definitions) => directorHolder.instance?.updateToolDefinitions(definitions),
      },
      mcpConnectController.signal,
    )
    .then(() => {
      if (toolset.dynamicRunner.currentDefinitions().length > baseToolCount) {
        pendingReload = true;
        void reloadIfIdle();
      }
    });

  await waitUntilExit();
  mcpConnectController.abort();
  exitAltScreen();

  const finishedAt = Date.now();
  const turnCollector = runSink.getTurnCollector();
  const sinkError = runSink.getRunError();
  await hookManager.dispatchPostRun(createRunSummary({
    task: config.task,
    status: runSink.getStatus(),
    startedAt,
    finishedAt,
    turnsUsed: turnCollector.getTurns().length,
    tokenUsage: turnCollector.getTokenUsage(),
    turns: turnCollector.getTurns(),
    toolCallCount: turnCollector.getToolCallCount(),
    ...(sinkError !== undefined ? { error: sinkError } : {}),
  }));

  if (reloadBarrier !== null) await reloadBarrier;
  try {
    await currentAgent.close();
  } catch {
    // ignore
  }
  try {
    await streamPromise;
  } catch {
    // ignore
  }
  await toolset.dispose();

  return resolveExitCode({
    runError,
    sinkError,
    status: runSink.getStatus(),
  });
}
