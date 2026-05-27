#!/usr/bin/env bun

import { join, resolve } from "node:path";

import { createAgent, fromToolRunner, stringTool } from "@intx/agent";
import type { SendResult } from "@intx/agent";
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

async function loadEnvFile(path: string): Promise<void> {
  try {
    const file = Bun.file(path);
    const text = await file.text();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || trimmed.length === 0) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      const unquoted = value.replace(/^["']|["']$/g, "");
      if (process.env[key] === undefined) {
        process.env[key] = unquoted;
      }
    }
  } catch {
    // File missing or unreadable — ignore
  }
}

/* eslint-disable no-console */

async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];

  // Strip optional "run" verb
  if (args[0] === "run") {
    args.shift();
  }

  const config = loadConfig(args);

  const state = await loadState(config.cwd);
  if (state !== null && state.status === "running" && !config.force) {
    console.error("A run is already in progress in this directory. Use --force to override.");
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
        id: config.providerName,
        provider: "openai",
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        model: config.model,
      },
    ],
    defaultSource: config.providerName,
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

  const streamPromise = (async () => {
    for await (const event of agent.stream()) {
      traceEvent(event);
    }
  })();

  let result: SendResult;
  try {
    result = await sendPromise;
  } catch (err) {
    await saveState(config.cwd, {
      status: "failed",
      turnsUsed: 0,
      task: config.task,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    });
    await agent.close();
    await streamPromise;
    await posixTools.dispose();
    throw err;
  }

  await saveState(config.cwd, {
    status: "done",
    turnsUsed: 0,
    task: config.task,
    startedAt: Date.now(),
    finishedAt: Date.now(),
  });

  console.log(result.reply);

  await agent.close();
  await streamPromise;
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

const projectRoot = resolve(import.meta.dirname, "..");
await loadEnvFile(resolve(projectRoot, ".env"));

void main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`interchange-code: ${message}`);
    process.exit(1);
  },
);
/* eslint-enable no-console */
