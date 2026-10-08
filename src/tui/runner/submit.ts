/**
 * Submit path for the TUI runner: composer-line routing/classification, the
 * submit handler, inbound-message building, send-failure settling, the
 * full user-prompt send, and queued/steer deliver routing.
 */

import { getLogger } from "@intx/log";
import type { InboundMessage } from "@intx/types/runtime";
import { OPERATOR_ORIGINATED_FLAG } from "../../agent/message-provenance.js";
import { appendSentMessage } from "../../session/sent-messages.js";
import { getTelemetry } from "../../telemetry/singleton.js";
import {
  cancelFeedbackCapture,
  captureFeedback,
  feedbackResultMessage,
  isFeedbackCapturePending,
  getLastTurnTraceId,
  takeFeedbackCapture,
} from "../../telemetry/feedback.js";
import { activateHeldTelemetry } from "../../telemetry/first-run.js";
import { setShellRunState } from "../shell/chrome.js";
import { surfaceSystemNotice } from "../shell/prompt.js";
import {
  captureAuthFailure,
  classifyAgentSendFailure,
  shouldSettleUiAfterSendFailure,
} from "../chrome-state.js";
import { ingestOperatorPrompt } from "../prompt-attachments.js";
import {
  imageAttachmentFromPath,
  type PendingImageAttachment,
} from "../image-attachments.js";
import {
  createLeftoverSend,
  createLiveSteerDeliver,
  routeQueuedDelivery,
  type AgentDeliveryResult,
} from "../delivery-queue.js";
import type { InferenceAttemptIdentity } from "./state.js";
import { tuiSendFailureMessage } from "./send-failure-message.js";
import type { ProviderFailureAttempt } from "../provider/failure-attempt.js";
import { AgentClosedError, type Agent, type SendResult } from "@intx/agent";
import { ASK_DIRECTOR_WAKE_PREFIX } from "../../subagent/fleet-report.js";
import { MAILBOX_MAIL_WAKE_PREFIX } from "../../subagent/mailbox-mail-drive.js";
import {
  hostOf,
  liveAgent,
  recordRunError,
  runWhileAgentBusy,
  sanitizeRunnerDiagnostic,
  type RunnerServices,
  type RunnerState,
} from "./state.js";
import { LOG_NAMESPACE_ROOT } from "../../branding.js";
import { buildCredentialRecoveryAlternatives } from "./credential-recovery.js";
import type { PendingCredentialRecovery } from "./credential-recovery.js";
import type { PendingReconnectRecovery } from "./reconnect-recovery.js";
import { listCommands } from "../commands/registry.js";

const tuiLogger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);

export type SubmissionRoute =
  | { kind: "empty" }
  | { kind: "command"; name: string; args: string }
  | { kind: "prompt"; text: string };

/**
 * Command names a leading-`/` token may dispatch to. Call sites own the set
 * — registry `listCommands()` names, the `/` popup catalog's source. A
 * supplier stays fresh across registry reloads; a plain set is a snapshot.
 */
export type KnownCommandNames =
  | readonly string[]
  | ReadonlySet<string>
  | (() => readonly string[] | ReadonlySet<string>);

function hasKnownCommand(known: KnownCommandNames, name: string): boolean {
  const raw = typeof known === "function" ? known() : known;
  const wanted = name.toLowerCase();
  for (const candidate of raw) {
    if (candidate.toLowerCase() === wanted) return true;
  }
  return false;
}

/**
 * What a submitted composer line is: a leading `/` is a slash command only
 * when its first token (lowercased, to whitespace) exactly matches a
 * registered id; anything else — absolute paths, unknown slashes — is a
 * model prompt, sent verbatim. Bare `/` stays empty. Callers omitting
 * `knownCommands` keep the legacy any-slash-is-a-command rule; product
 * call sites pass the registry set. The returned name is the canonical
 * lowercase id, so the exact `getCommand` lookup hits mixed-case input.
 */
export function routeSubmission(
  raw: string,
  knownCommands?: KnownCommandNames,
): SubmissionRoute {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "empty" };
  if (!trimmed.startsWith("/")) return { kind: "prompt", text: trimmed };
  const body = trimmed.slice(1).trim();
  if (body.length === 0) return { kind: "empty" };
  const sep = body.search(/\s/);
  const name = sep === -1 ? body : body.slice(0, sep);
  const args = sep === -1 ? "" : body.slice(sep + 1).trim();
  if (knownCommands !== undefined && !hasKnownCommand(knownCommands, name)) {
    return { kind: "prompt", text: trimmed };
  }
  return { kind: "command", name: name.toLowerCase(), args };
}

export interface SubmitHandlerDeps {
  dispatchCommand: (name: string, args: string) => void;
  sendPrompt: (
    text: string,
    attachments?: readonly PendingImageAttachment[],
  ) => void;
  /**
   * Registry names a leading-`/` token may dispatch to (see routeSubmission).
   */
  knownCommands?: KnownCommandNames;
  /** Consent-by-proceeding hook: runs only for real prompts, never commands. */
  onPromptSubmitted?: () => void;
  /**
   * When true, the next non-command submit is treated as intentional
   * feedback text (bare `/feedback` multi-turn mode) instead of a model
   * prompt.
   */
  isFeedbackCapturePending?: () => boolean;
  /**
   * Consume the pending feedback arm and handle the text; return the
   * operator message.
   */
  onFeedbackText?: (text: string) => string;
  /** Drop a pending multi-turn /feedback arm (empty Enter cancel). */
  cancelFeedbackCapture?: () => void;
  /** Surface a local system notice (feedback thanks / blocked / cancelled). */
  onSystemNotice?: (text: string) => void;
}

/** Where a submit lands: "agent" = model turn, "local" = handled here
 * (command or feedback), "empty" = no-op. */
export type SubmitOutcome = "agent" | "local" | "empty";

/**
 * Classify a composer line without side effects. Local = registered slash
 * command or armed multi-turn feedback text; empty = no-op (or
 * cancel-feedback); agent = real model turn.
 */
export function classifySubmission(
  text: string,
  options: {
    hasAttachments?: boolean;
    feedbackPending?: boolean;
    feedbackCaptureEnabled?: boolean;
    knownCommands?: KnownCommandNames;
  } = {},
): SubmitOutcome {
  const route = routeSubmission(text, options.knownCommands);
  const hasAttachments = options.hasAttachments === true;
  if (route.kind === "empty" && !hasAttachments) return "empty";
  if (route.kind === "command") return "local";
  if (
    route.kind === "prompt" &&
    options.feedbackPending === true &&
    options.feedbackCaptureEnabled === true
  ) {
    return "local";
  }
  return "agent";
}

export function createSubmitHandler(
  deps: SubmitHandlerDeps,
): (
  text: string,
  attachments?: readonly PendingImageAttachment[],
) => SubmitOutcome {
  return (text, attachments) => {
    const route = routeSubmission(text, deps.knownCommands);
    const hasAttachments = attachments !== undefined && attachments.length > 0;
    const feedbackPending = deps.isFeedbackCapturePending?.() === true;
    const feedbackCaptureEnabled = deps.onFeedbackText !== undefined;
    const outcome = classifySubmission(text, {
      hasAttachments,
      feedbackPending,
      feedbackCaptureEnabled,
      ...(deps.knownCommands !== undefined
        ? { knownCommands: deps.knownCommands }
        : {}),
    });

    // Empty Enter while /feedback is armed cancels instead of trapping the
    // operator.
    if (outcome === "empty") {
      if (feedbackPending) {
        deps.cancelFeedbackCapture?.();
        deps.onSystemNotice?.("Feedback cancelled.");
      }
      return "empty";
    }
    if (route.kind === "command") {
      // Other slash commands drop a bare-/feedback arm so the next
      // free-text line is not mis-routed as survey text.
      if (feedbackPending && route.name !== "feedback") {
        deps.cancelFeedbackCapture?.();
      }
      deps.dispatchCommand(route.name, route.args);
      return "local";
    }
    // Multi-turn /feedback: next Enter is survey text, not a model prompt.
    if (outcome === "local" && deps.onFeedbackText !== undefined) {
      const notice = deps.onFeedbackText(
        route.kind === "prompt" ? route.text : text,
      );
      deps.onSystemNotice?.(notice);
      return "local";
    }
    deps.onPromptSubmitted?.();
    deps.sendPrompt(route.kind === "prompt" ? route.text : "", attachments);
    return "agent";
  };
}

/**
 * Text sent alongside an image when the operator attached one without a
 * prompt.
 */
export const IMAGE_ONLY_PROMPT = "Please inspect the attached image.";

/**
 * Build the inbound message for a genuine operator submit (sendUserPrompt /
 * the "send" command result), with or without attachments. Carries
 * OPERATOR_ORIGINATED_FLAG so director.ts's loop-protection backstop can
 * tell it from system-originated sends (compaction continuations,
 * retries, nudges).
 */
export function userInboundMessage(
  text: string,
  attachments: readonly PendingImageAttachment[],
): InboundMessage {
  return {
    ref: { uid: 1, mailbox: "INBOX" },
    headers: {
      from: "user@local",
      to: ["agent@local"],
      date: new Date().toISOString(),
      messageId: `<${crypto.randomUUID()}@local>`,
      interchangeType: "conversation.message",
    },
    flags: [OPERATOR_ORIGINATED_FLAG],
    signatureStatus: "missing",
    content: text.length > 0 ? text : IMAGE_ONLY_PROMPT,
    attachments: attachments.map((a) => ({
      name: a.name,
      contentType: a.contentType,
      data: a.data,
    })),
  };
}

/**
 * Present at most one recovery surface when a send settles. The reconnect
 * offer re-auths the exact scope that failed, so it wins when armed and
 * wired; otherwise the credential picker; an armed reconnect with no
 * presenter must not swallow the credential fallback.
 */
export function presentSendRecoveryOffer(args: {
  credential: PendingCredentialRecovery | null;
  reconnect: PendingReconnectRecovery | null;
  presentCredentialRecovery?:
    | ((pending: PendingCredentialRecovery) => void)
    | undefined;
  presentReconnectRecovery?:
    | ((pending: PendingReconnectRecovery) => void)
    | undefined;
}): void {
  if (args.reconnect !== null && args.presentReconnectRecovery !== undefined) {
    args.presentReconnectRecovery(args.reconnect);
    return;
  }
  if (args.credential !== null) {
    args.presentCredentialRecovery?.(args.credential);
  }
}

/**
 * Wire the runtime submit path: system notices, the send-failure settle
 * path, attempt-tracked sends, and the full user-prompt send.
 */
export function createSubmitPath(
  state: RunnerState,
  services: RunnerServices,
  live: { attemptIdentity: () => InferenceAttemptIdentity; agentProxy: Agent },
): {
  send: (
    text: string,
    attachments?: readonly PendingImageAttachment[],
  ) => SubmitOutcome;
} {
  // Routed through the shell's notice path, not the transcript: a
  // transcript row before the first turn would wipe the whole composition
  // while the landing owns the screen.
  const systemNotice = (text: string): void => {
    surfaceSystemNotice(hostOf(state).shell, text);
  };
  state.systemNotice = systemNotice;
  state.approvalPersistNotice.notify = systemNotice;

  const isCodexAuthError = (err: unknown): boolean =>
    err instanceof Error && err.name === "CodexAuthError";
  const isXaiAuthError = (err: unknown): boolean =>
    err instanceof Error && err.name === "XaiAuthError";

  /** Settle the shell after a rejected send so the run does not look live. */
  const handleSendFailure = (
    err: unknown,
    attempt: InferenceAttemptIdentity,
    providerFailure: ProviderFailureAttempt,
    presentNotice = true,
  ): void => {
    const failure = classifyAgentSendFailure(
      err,
      state.sendAborted,
      isCodexAuthError,
      isXaiAuthError,
    );
    captureAuthFailure(getTelemetry(), failure);
    if (!shouldSettleUiAfterSendFailure(failure.kind)) return;
    if (failure.kind === "abort") return;
    recordRunError(state, err);
    if (presentNotice && !providerFailure.presented) {
      systemNotice(
        sanitizeRunnerDiagnostic(
          state,
          tuiSendFailureMessage(
            err,
            failure.kind,
            providerFailure.observed,
            attempt,
            providerFailure.error,
          ),
        ),
      );
      services.providerFailureAttempts.markPresented(providerFailure);
    }
    setShellRunState(hostOf(state).shell, "idle");
  };
  state.handleSendFailure = handleSendFailure;

  const sendWithAttemptIdentity = async (
    message: InboundMessage,
    send: (message: InboundMessage) => Promise<SendResult> = (next) =>
      live.agentProxy.send(next),
    presentFailureNotice = true,
  ): Promise<AgentDeliveryResult> => {
    hostOf(state).bridge.setSuspendedApprovalRecovery(
      services.suspendedApprovalRecovery.tryResumeOnce,
    );
    const attempt = live.attemptIdentity();
    const providerFailure = services.providerFailureAttempts.begin(attempt);
    const recoveryAttempt = state.credentialRecovery.begin(
      message,
      attempt.providerId,
    );
    state.credentialRecoveryAttempts.set(providerFailure, recoveryAttempt);
    const reconnectAttempt = state.reconnectRecovery.begin(
      message,
      attempt.providerId,
    );
    state.reconnectRecoveryAttempts.set(providerFailure, reconnectAttempt);
    try {
      await runWhileAgentBusy(state, async () => {
        const result = await send(message);
        // An ask-tier call parked on the reactor's approval gate settles the
        // send early; deliver the decision on the correlationId signal
        // channel so the parked run resumes.
        if (result.type === "suspended") {
          services.suspendedApprovalRecovery.capture(
            result,
            services.deliveryGeneration.capture(),
          );
        }
        await services.approvalResume.handle(result);
        // Settled: nothing is left for the stall watchdog to re-present.
        services.suspendedApprovalRecovery.clear();
      });
      return { status: "accepted" };
    } catch (error) {
      handleSendFailure(error, attempt, providerFailure, presentFailureNotice);
      if (error instanceof AgentClosedError) {
        return {
          status: "not-delivered",
          reason: "agent-closed",
          detail: error.message,
        };
      }
      return {
        status: "uncertain",
        detail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      const pending = state.credentialRecovery.settle(
        recoveryAttempt,
        buildCredentialRecoveryAlternatives(
          state.config,
          state.sessionId,
          recoveryAttempt.failedProvider,
        ),
      );
      presentSendRecoveryOffer({
        credential: pending,
        reconnect: state.reconnectRecovery.settle(reconnectAttempt),
        presentCredentialRecovery: state.presentCredentialRecovery,
        presentReconnectRecovery: state.presentReconnectRecovery,
      });
      services.providerFailureAttempts.sendSettled(providerFailure);
    }
  };
  state.sendWithAttemptIdentity = sendWithAttemptIdentity;

  /**
   * Full user-prompt send path: inline image paths become attachments,
   * @mentions are expanded, and the message is recorded for Up/Down recall.
   */
  const sendUserPrompt = async (
    text: string,
    pending: readonly PendingImageAttachment[],
  ): Promise<void> => {
    const stillCurrent = services.deliveryGeneration.capture();
    state.sendAborted = false;
    if (text.trim().length > 0) {
      void appendSentMessage(state.config.cwd, state.sessionId, text).catch(
        (err: unknown) => {
          tuiLogger.debug("sent-message append failed: {error}", {
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
    }
    const ingested = await ingestOperatorPrompt(
      text,
      state.config.cwd,
      imageAttachmentFromPath,
      pending,
    );
    if (!stillCurrent()) return;
    await sendWithAttemptIdentity(
      userInboundMessage(ingested.text, ingested.attachments),
    );
  };
  state.sendUserPrompt = sendUserPrompt;

  const send = createSubmitHandler({
    dispatchCommand: (name, args) => state.dispatchCommand?.(name, args),
    // Live registry names: a leading `/` dispatches only on an exact id
    // hit, so absolute paths fall through to the model as prompts.
    knownCommands: () => listCommands().map((c) => c.name),
    sendPrompt: (text, attachments) => {
      void sendUserPrompt(text, attachments ?? []).catch((error: unknown) => {
        handleSendFailure(error, live.attemptIdentity(), {
          observed: false,
          presented: false,
          error: undefined,
        });
      });
    },
    onPromptSubmitted: () => {
      if (state.telemetryFirstRun && state.liveTelemetryIntent) {
        void activateHeldTelemetry(
          state.trueGlobalSettingsPath,
          () => state.liveTelemetryIntent,
        );
      }
    },
    isFeedbackCapturePending,
    cancelFeedbackCapture,
    onFeedbackText: (text) => {
      takeFeedbackCapture();
      const status = captureFeedback(getTelemetry(), text, {
        turnTraceId: getLastTurnTraceId(),
      });
      return feedbackResultMessage(status);
    },
    onSystemNotice: systemNotice,
  });
  state.send = send;
  return { send };
}

/** Queued-drain and live-steer deliver routing handed to the host mount. */
export function createDeliverRouting(
  state: RunnerState,
  services: RunnerServices,
  live: { attemptIdentity: () => InferenceAttemptIdentity; agentProxy: Agent },
): ReturnType<typeof routeQueuedDelivery> {
  const failureStub = (): ProviderFailureAttempt => ({
    observed: false,
    presented: false,
    error: undefined,
  });
  return routeQueuedDelivery({
    send: createLeftoverSend({
      enqueue: services.sessionOps.enqueue,
      ingest: (text, pending) =>
        ingestOperatorPrompt(
          text,
          state.config.cwd,
          imageAttachmentFromPath,
          pending,
        ),
      send: async (text, pending) => {
        state.sendAborted = false;
        const send = state.sendWithAttemptIdentity;
        if (send === undefined) {
          return {
            status: "not-delivered",
            reason: "session-unavailable",
            detail: "session send path is unavailable",
          };
        }
        const targetAgent = liveAgent(state);
        return send(
          userInboundMessage(text, pending),
          (message) => targetAgent.send(message),
          false,
        );
      },
      recordSent: (text) => {
        if (text.trim().length === 0) return;
        if (text.startsWith(ASK_DIRECTOR_WAKE_PREFIX)) return;
        if (text.startsWith(MAILBOX_MAIL_WAKE_PREFIX)) return;
        void appendSentMessage(state.config.cwd, state.sessionId, text).catch(
          (err: unknown) => {
            tuiLogger.debug("sent-message append failed: {error}", {
              error: err instanceof Error ? err.message : String(err),
            });
          },
        );
      },
      captureGeneration: services.deliveryGeneration.capture,
      onFailure: (error) =>
        state.handleSendFailure?.(error, live.attemptIdentity(), failureStub()),
    }),
    parentCycleLive: () => hostOf(state).bridge.parentCycleLive,
    deliverSteer: createLiveSteerDeliver({
      enqueue: services.sessionOps.enqueue,
      ingest: (text, pending) =>
        ingestOperatorPrompt(
          text,
          state.config.cwd,
          imageAttachmentFromPath,
          pending,
        ),
      deliver: (text, pending, settle) => {
        const targetAgent = liveAgent(state);
        state.enqueueAgentDeliver?.(
          () => targetAgent.deliver(userInboundMessage(text, pending)),
          settle,
        );
      },
      captureGeneration: services.deliveryGeneration.capture,
      onFailure: (error) =>
        state.handleSendFailure?.(error, live.attemptIdentity(), failureStub()),
    }),
  });
}
