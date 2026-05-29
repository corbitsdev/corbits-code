import { join } from "node:path";

import { createAgent, fromToolRunner, stringTool } from "@intx/agent";
import type { SendResult } from "@intx/agent";
import { createPosixTools } from "@intx/tools-posix";
import type { ReactorEmittedEvent } from "@intx/inference";

import type { Config } from "./config.js";
import { createCodingDirector, submitOutputDefinition, submitPlanDefinition } from "./director.js";
import { authzPlugin } from "./plugins/authz-plugin.js";
import { pathEscapePlugin } from "./plugins/path-escape-plugin.js";
import { reReadBlockPlugin } from "./plugins/re-read-block-plugin.js";
import { verifyPlugin } from "./plugins/verify-plugin.js";
import { buildSystemPrompt } from "./prompts.js";
import { saveState, loadState, saveDirectorState, loadDirectorState, type DirectorPersistedState } from "./state.js";
import { runCritique } from "./critic.js";
import { createRenderer } from "./renderer.js";
import { consumeStream } from "./stream-consumer.js";

/* eslint-disable no-console */

export async function runAgent(
  config: Config,
  initialStartedAt?: number,
  initialDirectorState?: DirectorPersistedState,
  onEvent?: (event: ReactorEmittedEvent) => void,
): Promise<number> {
  const state = await loadState(config.cwd);
  if (state !== null && state.status === "running" && !config.force) {
    console.error("A run is already in progress in this directory. Use --force to override.");
    return 1;
  }

  const startedAt = initialStartedAt ?? Date.now();

  // directorHolder is populated after director is created; the re-read plugin
  // only executes during tool calls, which happen after wiring is complete.
  const directorHolder: { instance?: ReturnType<typeof createCodingDirector> } = {};

  const posixTools = createPosixTools({
    cwd: config.cwd,
    plugins: [
      pathEscapePlugin(config.cwd),
      authzPlugin(),
      verifyPlugin(),
      reReadBlockPlugin(() => directorHolder.instance),
    ],
  });

  const posixToolList = fromToolRunner(posixTools);
  const allDefinitions = [
    ...posixToolList.map((t) => t.definition),
    submitPlanDefinition,
    submitOutputDefinition,
  ];

  const director = createCodingDirector(
    buildSystemPrompt(),
    allDefinitions,
    initialDirectorState,
  );
  directorHolder.instance = director;

  const agentTools = [
    ...posixToolList,
    stringTool({
      definition: submitPlanDefinition,
      handler: async (args: Record<string, unknown>, _signal: AbortSignal): Promise<string> => {
        const steps = args.steps;
        if (!Array.isArray(steps) || steps.length === 0) {
          return "Error: submit_plan requires a non-empty steps array.";
        }
        return "Plan accepted.";
      },
    }),
    stringTool({
      definition: submitOutputDefinition,
      handler: async (_args: Record<string, unknown>, _signal: AbortSignal): Promise<string> => {
        if (!director.getState().planSubmitted) {
          return "Error: You must call submit_plan before submit_output.";
        }
        return "Submission accepted. The task is now complete.";
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
    systemPrompt: buildSystemPrompt(),
    tools: agentTools,
    director,
  });

  await saveState(config.cwd, {
    status: "running",
    turnsUsed: director.getTurnsUsed(),
    task: config.task,
    startedAt,
  });
  await saveDirectorState(config.cwd, director.getState());

  const renderer = createRenderer(startedAt);
  const sendPromise = agent.send(config.task);

  const streamPromise = consumeStream(agent.stream(), onEvent ?? renderer.render.bind(renderer));

  async function cleanup(): Promise<void> {
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
  }

  let result: SendResult;
  try {
    result = await sendPromise;
  } catch (err) {
    await saveState(config.cwd, {
      status: "failed",
      turnsUsed: director.getTurnsUsed(),
      task: config.task,
      startedAt,
      finishedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    });
    await saveDirectorState(config.cwd, director.getState());
    await cleanup();
    throw err;
  }

  const critique = await runCritique(config.cwd);
  if (!critique.passed) {
    await saveState(config.cwd, {
      status: "failed",
      turnsUsed: director.getTurnsUsed(),
      task: config.task,
      startedAt,
      finishedAt: Date.now(),
      error: critique.errors.join("; "),
    });
    await saveDirectorState(config.cwd, director.getState());
    console.error("Critique failed:");
    for (const e of critique.errors) {
      console.error(`  - ${e}`);
    }
    await cleanup();
    return 1;
  }

  await saveState(config.cwd, {
    status: "done",
    turnsUsed: director.getTurnsUsed(),
    task: config.task,
    startedAt,
    finishedAt: Date.now(),
  });
  await saveDirectorState(config.cwd, director.getState());

  console.log(result.reply);

  await cleanup();
  return 0;
}

export function traceEvent(event: ReactorEmittedEvent): void {
  switch (event.type) {
    case "inference.tool_call.start": {
      process.stderr.write(`[tool-start] ${event.data.name}\n`);
      break;
    }
    case "inference.tool_call.end": {
      process.stderr.write(
        `[tool] ${event.data.name} (${JSON.stringify(event.data.arguments)})\n`,
      );
      break;
    }
    case "tool.start": {
      process.stderr.write(`[exec-start] ${event.data.call.name}\n`);
      break;
    }
    case "tool.done": {
      const prefix = event.data.result.isError ? "[tool-error]" : "[tool-done]";
      process.stderr.write(`${prefix} ${event.data.result.callId}\n`);
      break;
    }
    case "inference.error": {
      process.stderr.write(
        `[inference-error] ${event.data.error.category}: ${event.data.error.message}\n`,
      );
      break;
    }
    case "reactor.error": {
      process.stderr.write(
        `[reactor-error] fatal=${event.data.fatal}: ${event.data.error}\n`,
      );
      break;
    }
    case "connector.reply": {
      process.stderr.write(`[reply] ${event.data.content}\n`);
      break;
    }
    case "reactor.done": {
      process.stderr.write(`[done]\n`);
      break;
    }
    default:
      break;
  }
}
/* eslint-enable no-console */
