import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { createAgent, fromToolRunner } from "@intx/agent";
import type { ReactorEmittedEvent } from "@intx/inference";
import { createPosixTools } from "@intx/tools-posix";
import type { Config, Mode } from "../config.js";
import type { PlanStep } from "./use-stream.js";
import { createChatDirector, type ApprovalGate } from "../director.js";
import { buildChatSystemPrompt } from "../prompts.js";
import { pathEscapePlugin } from "../plugins/path-escape-plugin.js";
import { authzPlugin } from "../plugins/authz-plugin.js";
import { verifyPlugin } from "../plugins/verify-plugin.js";
import { consumeStream } from "../stream-consumer.js";
import { App, type PlanGateEvent } from "./app.js";

export function createTUIEventEmitter(): EventEmitter {
  return new EventEmitter();
}

function saveMode(mode: Mode): void {
  const dir = join(homedir(), ".interchange");
  const configPath = join(dir, "config.json");
  let existing: Record<string, unknown> = {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // file absent — start fresh
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ ...existing, mode }, null, 2));
  } catch {
    // best-effort — non-fatal if write fails
  }
}

export async function runTUI(config: Config): Promise<number> {
  const emitter = createTUIEventEmitter();

  const approvalGate: ApprovalGate = (plan: PlanStep[]) => {
    return new Promise<boolean>((resolve) => {
      const event: PlanGateEvent = { plan, resolve };
      emitter.emit("plan.gate", event);
    });
  };

  const posixTools = createPosixTools({
    cwd: config.cwd,
    plugins: [
      pathEscapePlugin(config.cwd),
      authzPlugin(),
      verifyPlugin(),
    ],
  });

  const posixToolList = fromToolRunner(posixTools);
  const allDefinitions = [...posixToolList.map((t) => t.definition)];

  // Always wire the gate; the App's modeRef auto-approves when in teammate mode.
  // This lets mid-task toggle to manager take effect on subsequent plans.
  const director = createChatDirector(
    buildChatSystemPrompt(),
    allDefinitions,
    approvalGate,
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
        defaults: { maxTokens: 16384 },
      },
    ],
    defaultSource: config.providerName,
    systemPrompt: buildChatSystemPrompt(),
    tools: posixToolList,
    director,
  });

  const sink = (event: ReactorEmittedEvent): void => {
    emitter.emit("event", event);
  };

  // Render first so the App's plan.gate listener is registered before agent.send.
  const { waitUntilExit } = render(
    <App
      eventEmitter={emitter}
      agent={agent}
      sessionTitle={config.task}
      initialMode={config.mode}
      onModeChange={saveMode}
    />,
  );

  const streamPromise = consumeStream(agent.stream(), sink);

  // Send initial task if provided
  if (config.task.length > 0) {
    agent.send(config.task).catch(() => {});
  }

  await waitUntilExit();

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
