import { join } from "node:path";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { createAgent, fromToolRunner, stringTool } from "@intx/agent";
import type { ReactorEmittedEvent } from "@intx/inference";
import { createPosixTools } from "@intx/tools-posix";
import type { Config } from "../config.js";
import type { PlanStep } from "./use-stream.js";
import { askOperatorDefinition, createChatDirector, type ApprovalGate } from "../director.js";
import { buildChatSystemPrompt } from "../prompts.js";
import { pathEscapePlugin } from "../plugins/path-escape-plugin.js";
import { authzPlugin } from "../plugins/authz-plugin.js";
import { verifyPlugin } from "../plugins/verify-plugin.js";
import { permissionPlugin } from "../plugins/permission-plugin.js";
import { secretGuardPlugin } from "../plugins/secret-guard-plugin.js";
import { createPermissionGate } from "../permission/gate.js";
import { loadApprovals, saveApprovals } from "../permission/store.js";
import type { Approval } from "../permission/types.js";
import { consumeStream } from "../stream-consumer.js";
import { App } from "./app.js";
import type { OperatorGateEvent, PermissionGateEvent, PlanGateEvent } from "./hooks/use-gates.js";
import {
  createLifecycleHookManager,
  createRunSummary,
  createTurnContextCollector,
  discoverLifecycleHooks,
  hookDirectories,
  type RunSummary,
} from "../hooks.js";

export function createTUIEventEmitter(): EventEmitter {
  return new EventEmitter();
}

export function getTUIRunSummaryStatus(
  runCompleted: boolean,
  runError: string | undefined,
): RunSummary["status"] {
  if (runError !== undefined) return "failed";
  if (runCompleted) return "done";
  return "cancelled";
}

export async function runTUI(config: Config): Promise<number> {
  const emitter = createTUIEventEmitter();
  const startedAt = Date.now();
  const hookManager = createLifecycleHookManager({
    hooks: await discoverLifecycleHooks(hookDirectories(config.cwd)),
    onEvent: (event) => emitter.emit("hook", event),
  });
  let runCompleted = false;
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

  const posixTools = createPosixTools({
    cwd: config.cwd,
    plugins: [
      pathEscapePlugin(config.cwd),
      secretGuardPlugin(),
      authzPlugin(),
      permissionPlugin(permissionGate),
      verifyPlugin(),
    ],
  });

  const posixToolList = fromToolRunner(posixTools);
  const allDefinitions = [
    ...posixToolList.map((t) => t.definition),
    askOperatorDefinition,
  ];

  // Wire the gate so every submitted plan is surfaced to the operator for
  // explicit approval before the agent proceeds.
  const director = createChatDirector(
    buildChatSystemPrompt(),
    allDefinitions,
    approvalGate,
  );

  const agentTools = [
    ...posixToolList,
    stringTool({
      definition: askOperatorDefinition,
      handler: async (args: Record<string, unknown>, _signal: AbortSignal): Promise<string> => {
        const question = typeof args.question === "string" ? args.question : "";
        const options = Array.isArray(args.options) ? args.options.map(String) : [];
        if (options.length === 0) {
          return "Error: ask_operator requires at least one option.";
        }
        const index = await new Promise<number>((resolve) => {
          const event: OperatorGateEvent = { question, options, resolve };
          emitter.emit("operator.gate", event);
        });
        if (index < 0 || index >= options.length) {
          return `Error: invalid selection ${index}. Valid range: 0-${options.length - 1}.`;
        }
        return options[index] as string;
      },
    }),
  ];

  const agent = await createAgent({
    contextDir: join(config.cwd, ".agent-state", "context"),
    sources: [
      {
        id: config.providerName,
        provider: "openai",
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
        defaults: { maxTokens: 16384 },
      },
    ],
    defaultSource: config.providerName,
    systemPrompt: buildChatSystemPrompt(),
    tools: agentTools,
    director,
  });

  const turnCollector = createTurnContextCollector((ctx) => {
    hookManager.dispatchPostTurn(ctx);
  });

  const sink = (event: ReactorEmittedEvent): void => {
    turnCollector.observe(event);
    if (event.type === "reactor.done") {
      runCompleted = true;
    }
    if (event.type === "reactor.error") {
      const data = event.data as { error: string };
      runError = data.error;
    }
    if (event.type === "inference.error") {
      const data = event.data as { error: { message: string } };
      runError = data.error.message;
    }
    emitter.emit("event", event);
  };

  // Ink 7.0.4 has no enterAltScreen render option, so drive the alternate
  // screen buffer by hand: enter before render to hide pre-launch scrollback,
  // and restore it on exit (including abrupt process exit) so history returns.
  const exitAltScreen = (): void => {
    process.stdout.write("\x1b[?1049l");
  };
  process.stdout.write("\x1b[?1049h");
  process.once("exit", exitAltScreen);

  // Render first so the App's plan.gate and operator.gate listeners are registered before agent.send.
  const { waitUntilExit } = render(
    <App
      eventEmitter={emitter}
      agent={agent}
      sessionTitle={config.task}
      initialModel={config.model}
      initialHooks={hookManager.getStatuses()}
      onToggleHook={(hookId, enabled) => hookManager.setEnabled(hookId, enabled)}
      onAgentError={recordRunError}
    />,
  );

  const streamPromise = consumeStream(agent.stream(), sink);

  // Send initial task if provided
  if (config.task.length > 0) {
    agent.send(config.task).catch(recordRunError);
  }

  await waitUntilExit();
  process.removeListener("exit", exitAltScreen);
  exitAltScreen();

  const finishedAt = Date.now();
  const status = getTUIRunSummaryStatus(runCompleted, runError);
  await hookManager.dispatchPostRun(createRunSummary({
    task: config.task,
    status,
    startedAt,
    finishedAt,
    turnsUsed: turnCollector.getTurns().length,
    tokenUsage: turnCollector.getTokenUsage(),
    turns: turnCollector.getTurns(),
    toolCallCount: turnCollector.getToolCallCount(),
    ...(runError !== undefined ? { error: runError } : {}),
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
  await posixTools.dispose();

  return 0;
}
