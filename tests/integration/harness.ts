/**
 * Agent-loop integration harness for Corbits Code: wires `createAgent` to
 * `@intx/inference-testing` so full reactor cycles run without network I/O.
 *
 * Production-shaped stack: `createChatDirector`, `createAgentToolset` (posix +
 * permission middleware), and git-backed `createOptimizedContextStore`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgent,
  createDirectorRegistry,
  defineAgent,
  defineDirector,
  defineTool,
  type Agent,
} from "@intx/agent";
import { noopAuditStore, permissiveAuthorize } from "@intx/agent/testing";
import type { ReactorEmittedEvent } from "@intx/inference";
import { setupHarness, type Harness } from "@intx/inference-testing";
import type { ContextTransform, InferenceSource } from "@intx/types/runtime";
import { type } from "arktype";

import { createChatDirector } from "../../src/agent/director.js";
import { createAgentToolset } from "../../src/agent/tools.js";
import { ID_PREFIX } from "../../src/branding.js";
import type { PermissionGate } from "../../src/permission/gate.js";
import { createOptimizedContextStore } from "../../src/session/optimized-context-store.js";

export const INTEGRATION_SOURCE: InferenceSource = {
  id: "anthropic:claude-integration",
  provider: "anthropic",
  baseURL: "https://api.anthropic.com",
  apiKey: "sk-integration-test",
  model: "claude-integration",
};

export type IntegrationSession = {
  harness: Harness;
  cwd: string;
  workdir: string;
  agent: Agent;
  toolset: Awaited<ReturnType<typeof createAgentToolset>>;
};

export type OpenIntegrationSessionOpts = {
  permissionGate: PermissionGate;
  systemPrompt?: string;
  /** Pre-inference transforms, delivered the production way: riding deps. */
  contextTransforms?: ContextTransform[];
};

export async function openIntegrationSession(
  opts: OpenIntegrationSessionOpts,
): Promise<IntegrationSession> {
  const harness = setupHarness();
  const cwd = mkdtempSync(join(tmpdir(), "corbits-integration-cwd-"));
  const workdir = join(cwd, ".agent-state", "integration-session");

  const toolset = await createAgentToolset({
    cwd,
    permissionGate: opts.permissionGate,
    onOperatorGate: async () => ({ kind: "cancel" }),
  });

  const chatDirectorDef = defineDirector({
    id: `${ID_PREFIX}/chat`,
    configSchema: type({}),
    factory: (_config, _env, agentCtx) =>
      createChatDirector(agentCtx.systemPrompt, [...agentCtx.toolDefinitions], { onTasksChange: () => {}, inactivityTimeoutMs: 750_000 }),
  });

  const toolsFactory = defineTool({
    id: `${ID_PREFIX}/integration-tools`,
    factory: () => toolset.dynamicRunner,
  });

  const def = defineAgent({
    id: `${ID_PREFIX}/integration-agent`,
    systemPrompt: opts.systemPrompt ?? "You are a test agent. Follow the user.",
    tools: [toolsFactory],
    capabilities: [],
    director: chatDirectorDef.build({}),
    inference: {
      sources: [{ provider: INTEGRATION_SOURCE.provider, model: INTEGRATION_SOURCE.model }],
    },
  });

  const storage = await createOptimizedContextStore(workdir);
  const agent = await createAgent(def, {
    sources: [INTEGRATION_SOURCE],
    defaultSource: INTEGRATION_SOURCE.id,
    storage,
    workdir,
    deps: {
      ...harness.deps,
      ...(opts.contextTransforms !== undefined
        ? { contextTransforms: opts.contextTransforms }
        : {}),
    },
    audit: noopAuditStore(),
    authorize: permissiveAuthorize(),
    directors: createDirectorRegistry({
      factories: [chatDirectorDef.factory],
      defaultId: `${ID_PREFIX}/chat`,
    }),
    closeTimeoutMs: 0,
  });

  return { harness, cwd, workdir, agent, toolset };
}

export async function closeIntegrationSession(session: IntegrationSession): Promise<void> {
  try {
    await session.agent.close();
  } finally {
    await session.toolset.dispose();
    session.harness.dispose();
    rmSync(session.cwd, { recursive: true, force: true });
  }
}

export type TurnResult = {
  events: ReactorEmittedEvent[];
  reply: string;
};

/** One user turn; waits until `agent.send()` resolves (connector.reply). */
export async function runUntilDone(
  session: IntegrationSession,
  message: string,
): Promise<TurnResult> {
  const events: ReactorEmittedEvent[] = [];
  const stream = session.agent.stream();
  let turnComplete = false;
  const collect = (async () => {
    for await (const event of stream) {
      events.push(event);
      if (turnComplete && event.type === "message.run.ended") return;
    }
  })();

  const collectTask = collect;
  const sendResult = await Promise.all([
    session.agent.send(message).then((result) => {
      turnComplete = true;
      return result;
    }),
    session.harness.run({ wallClockBudgetMs: Infinity }),
    collectTask,
  ]).then(([result]) => result);

  return { events, reply: sendResult.reply };
}

export function toolDoneEvents(
  events: ReactorEmittedEvent[],
): Array<Extract<ReactorEmittedEvent, { type: "tool.done" }>> {
  return events.filter(
    (e): e is Extract<ReactorEmittedEvent, { type: "tool.done" }> => e.type === "tool.done",
  );
}
