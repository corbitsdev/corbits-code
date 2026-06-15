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
import { buildCodexSource, buildOpenAISource, type Config } from "../config/index.js";
import { codexProfileFromProviderName } from "../config/codex-providers.js";
import { registerCodexResponsesAdapter } from "../provider/codex-responses-adapter.js";
import { getValidCodexToken } from "../auth/codex/session.js";
import { refreshCodexInstructions } from "../auth/codex/instructions.js";
import { loadWorkflowPlugins } from "../workflows/index.js";
import { loadAgentPlugins } from "../agent/profiles.js";
import { registerOpenAICompatibleAdapter } from "../provider/openai-compatible-adapter.js";
import { setModelReasoningCapabilities } from "../provider/reasoning-effort.js";
import { loadPricing, readPricingCache } from "../cost/pricing-fetcher.js";
import { CORE_TOOL_NAMES } from "../agent/tool-search.js";
import type { SubAgentProvider } from "../subagent/index.js";
import type { InferenceSource, ToolDefinition } from "@intx/types/runtime";
import type { PlanStep } from "./use-stream.js";
import { createChatDirector, type ApprovalGate } from "../agent/director.js";
import { buildChatSystemPrompt } from "../agent/prompts.js";
import { gatherEnvironment } from "../agent/environment.js";
import { loadAgentContextExtensions } from "../agent/run-agent.js";
import { loadAgentProfiles } from "../agent/profiles.js";
import { createPermissionGate } from "../permission/gate.js";
import { createPermissionsAdmin } from "../permission/admin.js";
import { createAgentToolset } from "../agent/tools.js";
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
import { consumeStream } from "../session/stream-consumer.js";
import { enterAltScreen } from "../util/alt-screen.js";
import { App } from "./app.js";
import type { OperatorGateEvent, PermissionGateEvent, PlanGateEvent } from "./hooks/use-gates.js";
import {
  createLifecycleHookManager,
  createRunSummary,
  discoverLifecycleHooks,
  hookDirectories,
  type RunSummary,
} from "../session/hooks.js";
import { createRunSink } from "../session/run-sink.js";
import { generateSessionId, initSessionDir, sessionContextDir, sessionDir } from "../session/index.js";
import { WorkflowController } from "./workflow-controller.js";

export function createTUIEventEmitter(): EventEmitter {
  return new EventEmitter();
}

export { getTUIRunSummaryStatus } from "../session/run-sink.js";

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
  registerOpenAICompatibleAdapter();
  registerCodexResponsesAdapter();
  await loadWorkflowPlugins(config.settings?.workflowPlugins ?? []);
  await loadAgentPlugins(config.settings?.agentPlugins ?? []);
  // Seed reasoning capabilities from the cached models.dev metadata so the
  // /agent effort selector can gate non-reasoning models immediately, then
  // refresh from the network in the background (updates the cache for next run).
  setModelReasoningCapabilities((await readPricingCache())?.reasoning ?? {});
  void loadPricing()
    .then((cache) => {
      if (cache !== null) setModelReasoningCapabilities(cache.reasoning ?? {});
    })
    .catch(() => undefined);
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

  // Track the active subagent provider so a live /agent switch (provider, model,
  // or reasoning effort) reaches subagents spawned afterward. Seeded from config
  // and updated by the App through onSubAgentProviderChange.
  const liveSubAgentProvider: { current: SubAgentProvider } = {
    current: {
      providerName: config.providerName,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      model: config.model,
      ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
    },
  };

  // plan_enter calls are forwarded to the active director. Built after the
  // toolset, so a holder breaks the init cycle.
  const directorHolderForTools: { instance?: { enterPlanPhase: () => void } } = {};

  const toolset = await createAgentToolset({
    cwd: config.cwd,
    permissionGate,
    onOperatorGate: (question, options) =>
      new Promise<number>((resolve) => {
        const event: OperatorGateEvent = { question, options, resolve };
        emitter.emit("operator.gate", event);
      }),
    onPlanEnter: () => {
      directorHolderForTools.instance?.enterPlanPhase();
    },
    ...(config.mcpServers !== undefined ? { mcpServers: config.mcpServers } : {}),
    subAgent: {
      provider: () => liveSubAgentProvider.current,
      getWorkdirBase: () => sessionDir(config.cwd, sessionId),
    },
  });

  const agentExtensions = await loadAgentContextExtensions(config.cwd);
  const extensions = [...agentExtensions, ...(config.systemPromptExtensions ?? [])];
  const environment = await gatherEnvironment(config.cwd);
  const systemPrompt = buildChatSystemPrompt(extensions.length > 0 ? extensions : undefined, environment);

  const directorHolder: { instance?: ReturnType<typeof createChatDirector> } = {};

  // Owns the workflow lifecycle: slash-command starts, auto-invoke, capability
  // overrides, resume, and publishing status to the App via the emitter.
  const workflowController = new WorkflowController({
    cwd: config.cwd,
    emitter,
    getSessionId: () => sessionId,
    getToolDefinitions: () => toolset.dynamicRunner.currentDefinitions(),
    getDirector: () => directorHolder.instance,
  });

  // Dynamic tool discovery: the runner registers every tool (built-in + MCP) for
  // dispatch but advertises only the core set plus any promoted via tool_search.
  // `activeNames` persists across agent reloads, so `computeAdvertised` — run
  // inside the director factory on every (re)build — keeps the gate stable.
  const activeNames = new Set<string>();
  const computeAdvertised = (all: readonly ToolDefinition[]): ToolDefinition[] =>
    all.filter((d) => CORE_TOOL_NAMES.includes(d.name) || activeNames.has(d.name));

  const chatDirectorDef = defineDirector({
    id: "intercode/chat",
    configSchema: type({}),
    factory: (_config, _env, agentCtx) => {
      const d = createChatDirector(
        agentCtx.systemPrompt,
        computeAdvertised([...agentCtx.toolDefinitions]),
        approvalGate,
        undefined,
        (names) => promoteTools(names),
        undefined,
        (active) => emitter.emit("plan-phase", active),
      );
      directorHolder.instance = d;
      directorHolderForTools.instance = d;
      return d;
    },
  });

  const toolsFactory = defineTool({
    id: "intercode/tui-tools",
    factory: () => toolset.dynamicRunner,
  });

  const def = defineAgent({
    id: "intercode/tui-agent",
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
  // When the session starts on a Codex profile, seed the agent with a Responses
  // source (account id pulled from the resolved catalog entry, session id from
  // the run) rather than the OpenAI-compatible one.
  const initialCodexProfile = codexProfileFromProviderName(config.providerName);
  if (initialCodexProfile !== undefined) void refreshCodexInstructions().catch(() => {});
  const initialCodexAccountId = config.providers.find((p) => p.name === config.providerName)?.codexAccountId;
  const buildInitialSource = (): InferenceSource =>
    initialCodexProfile !== undefined
      ? buildCodexSource({
          id: config.providerName,
          apiKey: config.apiKey,
          model: config.model,
          sessionId: config.sessionId,
          ...(initialCodexAccountId !== undefined ? { accountId: initialCodexAccountId } : {}),
          ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
        })
      : buildOpenAISource({
          id: config.providerName,
          baseURL: config.baseURL,
          apiKey: config.apiKey,
          model: config.model,
          ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
        });

  const buildAgent = async (): Promise<Agent> => {
    const storage = await createIsogitStore(workdir);
    return createAgent(def, {
      source: buildInitialSource(),
      storage,
      workdir,
      audit: noopAuditStore(),
      authorize: permissiveAuthorize(),
      directors: createDirectorRegistry({ factories: [chatDirectorDef.factory], defaultId: "intercode/chat" }),
    });
  };

  const runSink = createRunSink({ emitter, hookManager });

  // Tool count before any MCP server connects; a reload is only worthwhile if
  // connecting actually added tools.
  const baseToolCount = toolset.dynamicRunner.currentDefinitions().length;

  let currentAgent = await buildAgent();
  let streamPromise = consumeStream(currentAgent.stream(), runSink.sink);

  // Serial operation queue. Each rotation (reload, interrupt, newSession) enqueues
  // an async task; they run one at a time. `send` awaits the tail of the queue
  // before dispatching so it never races a concurrent rebuild.
  let opQueueTail: Promise<void> = Promise.resolve();
  let inFlight = 0;
  let pendingReload = false;
  // When buildAgent() throws after the old agent has been closed, this flag is
  // set and subsequent `send` calls throw immediately rather than dispatching to
  // a closed agent.
  let fatalBuildError: Error | null = null;

  const enqueueOp = (op: () => Promise<void>): Promise<void> => {
    opQueueTail = opQueueTail.then(op, op);
    return opQueueTail;
  };

  const reloadIfIdle = (): void => {
    if (!pendingReload || inFlight > 0) return;
    pendingReload = false;
    void enqueueOp(async () => {
      const wasPlanPhaseActive = directorHolder.instance?.planPhaseActive ?? false;
      const old = currentAgent;
      await old.close().catch(() => undefined);
      await streamPromise.catch(() => undefined);
      currentAgent = await buildAgent();
      streamPromise = consumeStream(currentAgent.stream(), runSink.sink);
      // The rebuild made a fresh director; re-attach the active workflow and
      // restore plan phase so write tools stay blocked if the TUI is in Plan mode.
      workflowController.reattach();
      if (wasPlanPhaseActive) directorHolder.instance?.enterPlanPhase();
    });
  };

  // tool_search (and contextual triggers) promote tools into the advertised set.
  // Advertising takes effect on the next infer; a reload is scheduled so a newly
  // connected MCP tool also becomes dispatchable. Built-in tools are already in
  // the dispatch map, so promoting them needs no reload.
  const promoteTools = (names: string[]): void => {
    let changed = false;
    for (const name of names) {
      if (!activeNames.has(name)) {
        activeNames.add(name);
        changed = true;
      }
    }
    if (!changed) return;
    directorHolder.instance?.updateToolDefinitions(
      computeAdvertised(toolset.dynamicRunner.currentDefinitions()),
    );
    pendingReload = true;
    reloadIfIdle();
  };
  toolset.setToolPromoter(promoteTools);

  // The active Codex source, tracked whenever a "codex/<profile>" source is
  // selected so its access token can be refreshed before each send. Seeded from
  // config when the session starts on a Codex profile (buildAgent sets that
  // source directly, not through the proxy's setSource).
  let activeCodexSource: { profile: string; source: InferenceSource } | undefined =
    initialCodexProfile !== undefined
      ? { profile: initialCodexProfile, source: buildInitialSource() }
      : undefined;

  // Refresh the active Codex access token (if any) and push it onto the live
  // agent before a send. getValidCodexToken returns the stored token when still
  // valid and refreshes transparently otherwise, so this satisfies "check
  // before each inference call" without crashing the loop: a failure surfaces
  // as a CodexAuthError naming the profile and rejects the send.
  //
  // The source is pushed on every send, not only when the token changed: an
  // agent rebuild (tool promotion, interrupt, /clear) reseeds the source from
  // the original login-time token, so unconditionally re-pushing the live token
  // is what keeps the rebuilt agent from sending a stale credential.
  const refreshCodexBeforeSend = async (): Promise<void> => {
    const active = activeCodexSource;
    if (active === undefined) return;
    const token = await getValidCodexToken(active.profile);
    const source: InferenceSource =
      token === active.source.apiKey ? active.source : { ...active.source, apiKey: token };
    activeCodexSource = { profile: active.profile, source };
    currentAgent.setSource(source);
  };

  // Stable handle handed to the App so the underlying agent can be swapped out
  // from under it without a remount; method calls always target the live agent.
  const agentProxy: Agent = {
    send: async (content, opts) => {
      await opQueueTail;
      if (fatalBuildError !== null) throw fatalBuildError;
      inFlight++;
      try {
        await refreshCodexBeforeSend();
        return await currentAgent.send(content, opts);
      } finally {
        inFlight--;
        reloadIfIdle();
      }
    },
    stream: () => currentAgent.stream(),
    deliver: (message) => currentAgent.deliver(message),
    close: () => currentAgent.close(),
    setSource: (source) => {
      const profile = codexProfileFromProviderName(source.id);
      activeCodexSource = profile !== undefined ? { profile, source } : undefined;
      currentAgent.setSource(source);
    },
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
  const interrupt = (): void => {
    void enqueueOp(async () => {
      try {
        await currentAgent.close().catch(() => undefined);
        await streamPromise.catch(() => undefined);
        currentAgent = await buildAgent();
        streamPromise = consumeStream(currentAgent.stream(), runSink.sink);
        workflowController.reattach();
        fatalBuildError = null;
      } catch (err) {
        recordRunError(err);
        fatalBuildError = err instanceof Error ? err : new Error(String(err));
      }
    });
  };

  // /clear and /new start a fresh conversation: mint a new session id and its
  // own state directory, repoint the working tree at it, and rebuild the agent
  // so it resumes from an empty git-backed store. The prior session stays on
  // disk under its own id, resumable later.
  //
  // Sub-agent lifecycle on rotation: any sub-agents spawned before /clear
  // continue running in their own processes. Their onEvent output was captured
  // in the cleared transcript and will not appear in the new session's log.
  // This is acceptable — the sub-agents are isolated by session directory and
  // cannot write to the new session's store. They will terminate naturally.
  const newSession = (): void => {
    // The App clears its transcript unconditionally on /clear, so the backend
    // rotation is always enqueued regardless of contention; the queue serialises
    // it behind any in-progress op. Sub-agents nest under the new session
    // automatically because getWorkdirBase reads the live sessionId.
    void enqueueOp(async () => {
      try {
        sessionId = generateSessionId();
        workdir = sessionContextDir(config.cwd, sessionId);
        await initSessionDir(config.cwd, sessionId);
        permissionGate.reset();
        runSink.reset();
        await currentAgent.close().catch(() => undefined);
        await streamPromise.catch(() => undefined);
        currentAgent = await buildAgent();
        streamPromise = consumeStream(currentAgent.stream(), runSink.sink);
        // A fresh session drops any active workflow.
        workflowController.reset();
        fatalBuildError = null;
      } catch (err) {
        recordRunError(err);
        fatalBuildError = err instanceof Error ? err : new Error(String(err));
      }
    });
  };

  const profilesDir = join(config.cwd, ".agents", "agents");
  const initialProfiles = await loadAgentProfiles(profilesDir);

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
      {...(config.reasoningEffort !== undefined ? { initialReasoningEffort: config.reasoningEffort } : {})}
      providers={config.providers}
      globalSettingsPath={config.globalSettingsPath}
      {...(config.globalDefaultProvider !== undefined ? { globalDefaultProvider: config.globalDefaultProvider } : {})}
      cwd={config.cwd}
      initialTask={config.task}
      initialHooks={hookManager.getStatuses()}
      onToggleHook={(hookId, enabled) => hookManager.setEnabled(hookId, enabled)}
      onAgentError={recordRunError}
      onInterrupt={interrupt}
      onNewSession={newSession}
      permissionsAdmin={permissionsAdmin}
      {...(config.profile !== undefined ? { profile: config.profile } : {})}
      initialAuto={config.auto}
      onToggleAuto={(value) => permissionGate.setAuto(value)}
      {...(config.tiers !== undefined ? { initialTiers: config.tiers } : {})}
      initialProfiles={initialProfiles}
      profilesDir={profilesDir}
      onSubAgentProviderChange={(provider) => {
        liveSubAgentProvider.current = provider;
      }}
      onStartWorkflow={(name) => workflowController.start(name)}
      listWorkflows={() => workflowController.list()}
      onEnterPlanMode={() => {
        directorHolder.instance?.enterPlanPhase();
        // Promote submit_plan so the model can call it in plan mode.
        promoteTools(["submit_plan"]);
      }}
      onExitPlanMode={() => directorHolder.instance?.exitPlanPhase()}
      onToggleCapability={(name) => workflowController.toggleCapability(name)}
      initialWorkflowStatus={workflowController.status()}
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
        // MCP tools register for dispatch but stay unadvertised (blind) until
        // tool_search promotes them, so they never bloat the per-turn context.
        onToolsChanged: (definitions) =>
          directorHolder.instance?.updateToolDefinitions(computeAdvertised(definitions)),
      },
      mcpConnectController.signal,
    )
    .then(async () => {
      if (toolset.dynamicRunner.currentDefinitions().length > baseToolCount) {
        pendingReload = true;
        reloadIfIdle();
      }
      // Now that the capability map reflects connected MCP servers, restore any
      // persisted workflow, then auto-invoke the profile's workflow if one is
      // declared and nothing is already active. --no-workflow suppresses this.
      await workflowController.resume();
      if (!config.noWorkflow && config.workflow !== undefined && !workflowController.isActive()) {
        workflowController.autoInvoke(config.workflow);
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

  await opQueueTail.catch(() => undefined);
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
