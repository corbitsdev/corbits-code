/**
 * Agent-loop integration harness for Corbits Code: wires
 * `createAgentWithLiveToolDispatch` (production default) to
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
import type { AuthzCallResult } from "@intx/inference";
import type { ReactorEmittedEvent } from "@intx/inference";
import { setupHarness, type Harness } from "@intx/inference-testing";
import type { ContextTransform, ContextStore, InferenceSource } from "@intx/types/runtime";
import { type } from "arktype";

import { createAgentWithLiveToolDispatch } from "../../src/agent/live-tool-dispatch.js";
import { createChatDirector } from "../../src/agent/director.js";
import { createAgentToolset } from "../../src/agent/tools.js";
import { ID_PREFIX } from "../../src/branding.js";
import type { PermissionGate } from "../../src/permission/gate.js";
import { createOptimizedContextStore } from "../../src/session/optimized-context-store.js";
import {
  applyRecordingPolicyToText,
  createCompactionArchive,
  createPrimaryDeliveryAdmission,
  hashAuthorizedBytes,
  wrapAuthorizeWithEvidenceArchive,
  type CompactionArchive,
} from "../../src/session/compaction-archive.js";
import { assertReplySend } from "../../src/subagent/run.js";
import { createModelSummarizer, type CompletionFn } from "../../src/session/summarizer.js";
import {
  buildCompactionContinuationMessage,
  createSessionPruningCompactor,
} from "../../src/session/runtime-assembly.js";

export const INTEGRATION_SOURCE: InferenceSource = {
  id: "anthropic:claude-integration",
  provider: "anthropic",
  baseURL: "https://api.anthropic.com",
  apiKey: "sk-integration-test",
  model: "claude-integration",
};

export interface IntegrationSession {
  harness: Harness;
  cwd: string;
  workdir: string;
  agent: Agent;
  toolset: Awaited<ReturnType<typeof createAgentToolset>>;
}

export interface OpenIntegrationSessionOpts {
  permissionGate: PermissionGate;
  /** Registers the production compactor and continuation; only inference is replaced. */
  compactionCompletion?: CompletionFn;
  /** Reactor authorization override (defaults to permissive). */
  authorize?: (
    resource: string,
    action: string,
    context: unknown,
  ) => Promise<AuthzCallResult>;
  systemPrompt?: string;
  /** Pre-inference transforms, delivered the production way: riding deps. */
  contextTransforms?: ContextTransform[];
  /** Override to pin the published createAgent snapshot (characterization). */
  createAgentFn?: typeof createAgent;
}

export async function openIntegrationSession(
  opts: OpenIntegrationSessionOpts,
): Promise<IntegrationSession> {
  const harness = setupHarness();
  const cwd = mkdtempSync(join(tmpdir(), "corbits-integration-cwd-"));
  const workdir = join(cwd, ".agent-state", "integration-session");
  const evidenceArchiveHolder: { current: CompactionArchive | undefined } = { current: undefined };
  const storageHolder: { current: ContextStore | undefined } = { current: undefined };

  const toolset = await createAgentToolset({
    cwd,
    permissionGate: opts.permissionGate,
    onOperatorGate: async () => ({ kind: "cancel" }),
    ...(opts.compactionCompletion !== undefined
      ? {
          getEvidenceArchive: () => evidenceArchiveHolder.current,
          getBlobWriter: () => storageHolder.current?.writeBlob,
          getContextDir: () => workdir,
        }
      : {}),
  });

  const chatDirectorDef = defineDirector({
    id: `${ID_PREFIX}/chat`,
    configSchema: type({}),
    factory: (_config, _env, agentCtx) =>
      createChatDirector(agentCtx.systemPrompt, [...agentCtx.toolDefinitions], {
        onTasksChange: () => undefined,
        inactivityTimeoutMs: 750_000,
        ...(opts.compactionCompletion !== undefined
          ? { requestContinuation: () => agent.deliver(buildCompactionContinuationMessage()) }
          : {}),
      }),
  });

  const toolsFactory = defineTool({
    id: `${ID_PREFIX}/integration-tools`,
    definitions: [],
    factory: () => toolset.dynamicRunner,
  });

  const def = defineAgent({
    id: `${ID_PREFIX}/integration-agent`,
    systemPrompt: opts.systemPrompt ?? "You are a test agent. Follow the user.",
    tools: [toolsFactory],
    capabilities: [],
    director: chatDirectorDef.build({}),
    inference: {
      sources: [
        {
          provider: INTEGRATION_SOURCE.provider,
          model: INTEGRATION_SOURCE.model,
        },
      ],
    },
  });

  const storage = await createOptimizedContextStore(workdir);
  storageHolder.current = storage;
  const startAgent = opts.createAgentFn ?? createAgentWithLiveToolDispatch;
  const baseAuthorize = opts.authorize ?? permissiveAuthorize();
  let storageForAgent: ContextStore = storage;
  let authorize = baseAuthorize;
  let primaryArchive: CompactionArchive | undefined;
  if (opts.compactionCompletion !== undefined) {
    const archive = createCompactionArchive({
      sessionId: "integration-session",
      contextDir: workdir,
      writeBlob: (key, bytes, contentType) => storage.writeBlob(key, bytes, contentType),
      readBlob: (key) => storage.readBlob(key),
    });
    primaryArchive = archive;
    evidenceArchiveHolder.current = archive;
    storageForAgent = {
      ...storage,
      async writeBlob(key, bytes, contentType, signal) {
        await storage.writeBlob(key, bytes, contentType, signal);
        if (!key.startsWith("img-")) return;
        await archive.recordExistingBlobReference({
          kind: "attachment",
          blobKey: key,
          contentHash: hashAuthorizedBytes(bytes),
          provenance: "persistBlobs:aged-image",
        });
      },
      async writeResponse(turn, signal) {
        const content = turn.content.map((block) => {
          if (block.type !== "text") return block;
          const text = applyRecordingPolicyToText(block.text);
          return text === block.text ? block : { ...block, text };
        });
        const admitted = { ...turn, content };
        for (const block of admitted.content) {
          if (block.type === "text" && block.text.length > 0) {
            await archive.recordAuthorizedPayload({
              kind: "assistant_text",
              payload: block.text,
              provenance: "writeResponse:post-policy",
            });
          }
        }
        return storage.writeResponse(admitted, signal);
      },
    };
    authorize = wrapAuthorizeWithEvidenceArchive(baseAuthorize, () => archive);
  }
  const innerAgent = await startAgent(def, {
    sources: [INTEGRATION_SOURCE],
    defaultSource: INTEGRATION_SOURCE.id,
    storage: storageForAgent,
    workdir,
    deps: {
      ...harness.deps,
      ...(opts.contextTransforms !== undefined
        ? { contextTransforms: opts.contextTransforms }
        : {}),
    },
    audit: noopAuditStore(),
    authorize,
    directors: createDirectorRegistry({
      factories: [chatDirectorDef.factory],
      defaultId: `${ID_PREFIX}/chat`,
    }),
    ...(opts.compactionCompletion !== undefined
      ? {
          compactors: {
            "pruning-compactor": createSessionPruningCompactor({
              summarize: createModelSummarizer({
                getSource: () => INTEGRATION_SOURCE,
                deps: harness.deps,
                complete: opts.compactionCompletion,
                getArchive: () => evidenceArchiveHolder.current,
              }),
            }),
          },
        }
      : {}),
    closeTimeoutMs: 0,
  });
  const agent =
    primaryArchive === undefined
      ? innerAgent
      : createPrimaryDeliveryAdmission(innerAgent, primaryArchive);

  return { harness, cwd, workdir, agent, toolset };
}

export async function closeIntegrationSession(
  session: IntegrationSession,
): Promise<void> {
  try {
    await session.agent.close();
  } finally {
    await session.toolset.dispose();
    session.harness.dispose();
    rmSync(session.cwd, { recursive: true, force: true });
  }
}

export interface TurnResult {
  events: ReactorEmittedEvent[];
  reply: string;
}

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

  if (sendResult.type !== "reply") assertReplySend(sendResult);
  return { events, reply: sendResult.reply };
}

export function toolDoneEvents(
  events: ReactorEmittedEvent[],
): Extract<ReactorEmittedEvent, { type: "tool.done" }>[] {
  return events.filter(
    (e): e is Extract<ReactorEmittedEvent, { type: "tool.done" }> =>
      e.type === "tool.done",
  );
}

export type SendOutcome = Awaited<ReturnType<Agent["send"]>>;

export interface SuspendedTurn {
  /** All events seen on the stream so far (including the suspension). */
  events: ReactorEmittedEvent[];
  result: SendOutcome;
  /** Resolves with the resumed cycle's reply text. */
  reply: () => Promise<string>;
  /** Events accumulated at call time. */
  waitSettled: () => Promise<void>;
}

/**
 * One user turn driven under a single harness pump. The turn is expected to
 * park on the reactor's approval gate; the caller resolves the approval and
 * then awaits `reply()` for the resumed cycle's answer.
 */
export async function runUntilSuspended(
  session: IntegrationSession,
  message: string,
): Promise<SuspendedTurn> {
  const events: ReactorEmittedEvent[] = [];
  let resolveReply: (text: string) => void = () => undefined;
  const replyPromise = new Promise<string>((resolve) => {
    resolveReply = resolve;
  });
  const stream = session.agent.stream();
  const settled = (async () => {
    for await (const event of stream) {
      events.push(event);
      if (event.type === "connector.reply") resolveReply(event.data.content);
    }
  })().catch(() => undefined);
  void session.harness
    .run({ wallClockBudgetMs: 30_000 })
    .catch(() => undefined);

  const result = await session.agent.send(message);
  return {
    events,
    result,
    reply: () => replyPromise,
    waitSettled: () => settled,
  };
}

/** Deliver an approval decision on the correlationId signal channel. */
export function deliverDecision(
  session: IntegrationSession,
  correlationId: string,
  outcome: "approved" | "rejected",
  message?: string,
): void {
  session.agent.deliver({
    ref: { uid: 0, mailbox: "approval" },
    headers: {
      from: "approval@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `approval-${correlationId}`,
      interchangeCorrelationId: correlationId,
    },
    flags: [],
    content: JSON.stringify(
      message !== undefined ? { outcome, message } : { outcome },
    ),
    signatureStatus: "missing",
  });
}
