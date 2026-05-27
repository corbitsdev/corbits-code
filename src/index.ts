#!/usr/bin/env bun

import { join } from "node:path";

import { createAgent, fromToolRunner, stringTool } from "@intx/agent";
import { createPosixTools } from "@intx/tools-posix";
import type { ReactorEmittedEvent } from "@intx/inference";
import type { ToolResult } from "@intx/types/runtime";

import { loadConfig } from "./config.js";
import { createCodingDirector, submitOutputDefinition } from "./director.js";
import { authzPlugin } from "./plugins/authz-plugin.js";
import { pathEscapePlugin } from "./plugins/path-escape-plugin.js";
import { verifyPlugin } from "./plugins/verify-plugin.js";
import { buildSystemPrompt } from "./prompts.js";
import { saveState, loadState } from "./state.js";

/* eslint-disable no-console */

async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];

  // Strip optional "run" verb
  if (args[0] === "run") {
    args.shift();
  }

  const config = loadConfig(args);

  const state = await loadState(config.cwd);
  if (state !== null && state.status === "running") {
    console.error("A run is already in progress in this directory.");
    return 1;
  }

  const posixTools = createPosixTools({
    cwd: config.cwd,
    plugins: [
      pathEscapePlugin(config.cwd),
      authzPlugin(),
      verifyPlugin(),
    ],
  });

  const agentTools = [
    ...fromToolRunner(posixTools),
    stringTool({
      definition: submitOutputDefinition,
      handler: async (_args: Record<string, unknown>, _signal: AbortSignal): Promise<string> => {
        return "Submission accepted. The task is now complete.";
      },
    }),
  ];

  const director = createCodingDirector(
    buildSystemPrompt(),
    agentTools.map((t) => t.definition),
    config.maxTurns,
  );

  const agent = await createAgent({
    contextDir: join(config.cwd, ".agent-state", "context"),
    sources: [
      {
        id: "xai",
        provider: "openai",
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
      },
    ],
    defaultSource: "xai",
    systemPrompt: buildSystemPrompt(),
    tools: agentTools,
    director,
  });

  await saveState(config.cwd, {
    status: "running",
    turnsUsed: 0,
    task: config.task,
    startedAt: Date.now(),
  });

  const sendPromise = agent.send(config.task);

  for await (const event of agent.stream()) {
    traceEvent(event);
  }

  const result = await sendPromise;

  await saveState(config.cwd, {
    status: "done",
    turnsUsed: 0,
    task: config.task,
    startedAt: Date.now(),
    finishedAt: Date.now(),
  });

  console.log(result.reply);

  await agent.close();
  await posixTools.dispose();
  return 0;
}

function traceEvent(event: ReactorEmittedEvent): void {
  switch (event.type) {
    case "inference.tool_call.end": {
      process.stderr.write(
        `[tool] ${event.data.name} (${JSON.stringify(event.data.arguments)})\n`,
      );
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

void main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`interchange-code: ${message}`);
    process.exit(1);
  },
);
/* eslint-enable no-console */
