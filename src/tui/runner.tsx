import { join } from "node:path";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { createAgent } from "@intx/agent";
import { buildOpenAISource, type Config } from "../config.js";
import type { PlanStep } from "./use-stream.js";
import { createChatDirector, type ApprovalGate } from "../director.js";
import { buildChatSystemPrompt } from "../prompts.js";
import { createPermissionGate } from "../permission/gate.js";
import { createAgentToolset } from "../agent-tools.js";
import { loadApprovals, saveApprovals } from "../permission/store.js";
import type { Approval } from "../permission/types.js";
import { consumeStream } from "../stream-consumer.js";
import { enterAltScreen } from "../alt-screen.js";
import { App } from "./app.js";
import type { OperatorGateEvent, PermissionGateEvent, PlanGateEvent } from "./hooks/use-gates.js";
import {
  createLifecycleHookManager,
  createRunSummary,
  discoverLifecycleHooks,
  hookDirectories,
} from "../hooks.js";
import { createRunSink } from "../run-sink.js";

export function createTUIEventEmitter(): EventEmitter {
  return new EventEmitter();
}

export { getTUIRunSummaryStatus } from "../run-sink.js";

export async function runTUI(config: Config): Promise<number> {
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

  const approvals = await loadApprovals(config.cwd);
  const permissionGate = createPermissionGate({
    approvals,
    requestApproval: (request) =>
      new Promise((resolve) => {
        const event: PermissionGateEvent = { request, resolve };
        emitter.emit("permission.gate", event);
      }),
    persist: (_approval: Approval) => {
      void saveApprovals(config.cwd, approvals);
    },
    interactive: true,
    skipPermissions: config.dangerouslySkipPermissions,
  });

  const toolset = await createAgentToolset({
    cwd: config.cwd,
    permissionGate,
    onOperatorGate: (question, options) =>
      new Promise<number>((resolve) => {
        const event: OperatorGateEvent = { question, options, resolve };
        emitter.emit("operator.gate", event);
      }),
  });

  const systemPrompt = buildChatSystemPrompt(config.systemPromptExtensions);

  const director = createChatDirector(
    systemPrompt,
    toolset.allDefinitions,
    approvalGate,
  );

  const agent = await createAgent({
    contextDir: join(config.cwd, ".agent-state", "context"),
    sources: [
      buildOpenAISource({
        id: config.providerName,
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
        displayName: config.providerName,
      }),
    ],
    defaultSource: config.providerName,
    systemPrompt,
    tools: toolset.tools,
    director,
  });

  const runSink = createRunSink({ emitter, hookManager });

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
      agent={agent}
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
      {...(config.profile !== undefined ? { profile: config.profile } : {})}
    />,
    { exitOnCtrlC: false },
  );

  const streamPromise = consumeStream(agent.stream(), runSink.sink);

  await waitUntilExit();
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

  try {
    await agent.close();
  } catch {
    // ignore
  }
  try {
    await streamPromise;
  } catch {
    // ignore
  }
  await toolset.dispose();

  return 0;
}
