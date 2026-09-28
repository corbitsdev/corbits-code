/**
 * End-to-end scenario harness: full agent-loop runs against the production
 * stack — live tool dispatch, chat director, posix tools plus permission
 * middleware, git-backed context store, production compactor — with only
 * inference scripted by @intx/inference-testing. `e2e/integration-harness.ts` owns
 * the assembly; this layer adds fixture-repo seeding and small scenario
 * conveniences so e2e files stay declarative.
 *
 * Deliberate boundary: no TUI and no process spawn here — a scenario drives
 * `agent.send` through the same seam the runners use. PTY-level coverage is
 * a separate layer and out of scope for this harness.
 */

import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ReactorEmittedEvent } from "@intx/inference";
import type { InboundMessage } from "@intx/types/runtime";

import { OPERATOR_ORIGINATED_FLAG } from "../src/agent/message-provenance.js";
import {
  createPermissionGate,
  type PermissionGate,
} from "../src/permission/gate.js";
import { initTemporaryGitRepo } from "../src/testkit/temporary-git-repo.js";
import {
  closeIntegrationSession,
  openIntegrationSession,
  type IntegrationSession,
  type OpenIntegrationSessionOpts,
  type SendOutcome,
} from "./integration-harness.js";
import { COMPACTION_CONTINUATION_EVENT } from "../src/agent/compaction.js";
import {
  buildCompactionContinuationMessage,
  createContinuationGate,
} from "../src/session/runtime-assembly.js";

export {
  runUntilDone,
  toolDoneEvents,
  type SendOutcome,
} from "./integration-harness.js";

export type E2ESession = IntegrationSession;

export interface OpenE2ESessionOpts extends OpenIntegrationSessionOpts {
  /**
   * Name of a `fixtures/<name>` directory copied into the session cwd
   * before the scenario runs. `node_modules` and `.git` are skipped: fixture
   * deps install into the real repo, and the repo marker belongs to the
   * `git` option, not to whatever the fixture happens to contain.
   */
  fixture?: string;
  /**
   * Initialize the session cwd as a git repository. Defaults to true — a
   * "fixture-repo run" should look like one to worktree-aware permission
   * and trust checks. Pass false only when the scenario asserts on
   * non-repo behavior.
   */
  git?: boolean;
}

export async function openE2ESession(
  opts: OpenE2ESessionOpts,
): Promise<E2ESession> {
  const { fixture, git = true, ...sessionOpts } = opts;
  const session = await openIntegrationSession(sessionOpts);
  if (fixture !== undefined) seedFixture(session, fixture);
  if (git) initTemporaryGitRepo(session.cwd);
  return session;
}

export async function closeE2ESession(session: E2ESession): Promise<void> {
  await closeIntegrationSession(session);
}

/** Permission gate that allows everything: the common e2e default. */
export function e2ePermissionGate(): PermissionGate {
  return createPermissionGate({
    approvals: [],
    interactive: false,
    skipPermissions: true,
    reactorGated: false,
  });
}

/** Write (or overwrite) a file inside the session cwd mid-scenario. */
export function seedFile(
  session: E2ESession,
  relativePath: string,
  content: string,
): void {
  const path = join(session.cwd, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export interface OperatorTurn {
  /** The exact message sent — recovery flows key on its identity. */
  message: InboundMessage;
  events: ReactorEmittedEvent[];
  /** The raw send result — a terminally-failed turn is not asserted here. */
  outcome: SendOutcome | unknown;
}

/**
 * Send one operator message and pump the harness until the send settles,
 * whatever the outcome. Unlike runUntilDone this never asserts a reply —
 * scenarios that script a terminal failure (credential recovery, provider
 * outage) need the failure's event stream plus the send outcome, not a
 * thrown expectation.
 */
export async function sendOperatorTurn(
  session: E2ESession,
  text: string,
): Promise<OperatorTurn> {
  const message: InboundMessage = {
    ref: { uid: 1, mailbox: "INBOX" },
    headers: {
      from: "user@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `<${crypto.randomUUID()}@local>`,
      interchangeType: "conversation.message",
    },
    flags: [OPERATOR_ORIGINATED_FLAG],
    content: text,
    signatureStatus: "missing",
  };
  const events: ReactorEmittedEvent[] = [];
  const continuationGate = createContinuationGate();
  // The collector outlives the send: recovery scenarios deliver a follow-up
  // turn after this returns, and its events keep appending to `events`. The
  // catch mirrors runUntilSuspended — a stream error must not become an
  // unhandled rejection in the shared test process.
  void (async () => {
    for await (const event of session.agent.stream()) {
      events.push(event);
      if (event.type === COMPACTION_CONTINUATION_EVENT) {
        if (continuationGate.shouldDeliver(event.seq)) {
          session.agent.deliver(buildCompactionContinuationMessage());
        }
      }
    }
  })().catch(() => undefined);
  const outcome = await Promise.all([
    session.agent.send(message).then(
      (result) => result,
      (error: unknown) => error,
    ),
    session.harness.run({ wallClockBudgetMs: Infinity }),
  ]).then(([result]) => result);
  return { message, events, outcome };
}

export interface ScriptedReply {
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
}

/**
 * Queue one model response per inference request, in order — the common
 * "model calls tools, then answers" scenario spine. Thin sugar over
 * `scenario.replyOnce`; reach for `whenRequestBodyMatches`/`createStream`
 * directly when a reply must key on request content or timing.
 */
export function scriptReplies(
  session: E2ESession,
  replies: readonly ScriptedReply[],
): void {
  for (const reply of replies) {
    session.harness.scenario.replyOnce("anthropic", {
      text: reply.text ?? "",
      ...(reply.toolCalls !== undefined ? { toolCalls: reply.toolCalls } : {}),
    });
  }
}

function seedFixture(session: E2ESession, name: string): void {
  const source = join(import.meta.dir, "..", "fixtures", name);
  cpSync(source, session.cwd, {
    recursive: true,
    filter: (path) => !/(^|[/\\])(node_modules|\.git)([/\\]|$)/.test(path),
  });
}
