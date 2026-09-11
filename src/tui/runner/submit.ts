/**
 * Submit path for the TUI runner: composer-line routing/classification, the
 * submit handler, the operator inbound-message builder, the send-failure
 * settle path, the full user-prompt send, and the host's queued/steer
 * deliver routing.
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
} from "../session-chrome.js";
import { ingestOperatorPrompt } from "../prompt-attachments.js";
import {
  imageAttachmentFromPath,
  type PendingImageAttachment,
} from "../image-attachments.js";
import {
  createLeftoverSend,
  createLiveSteerDeliver,
  routeQueuedDelivery,
} from "../queued-delivery.js";
import type { InferenceAttemptIdentity } from "./state.js";
import { tuiSendFailureMessage } from "./send-failure-message.js";
import type { ProviderFailureAttempt } from "../provider/failure-attempt.js";
import type { Agent } from "@intx/agent";
import { ASK_DIRECTOR_WAKE_PREFIX } from "../../subagent/fleet-report.js";
import { MAILBOX_MAIL_WAKE_PREFIX } from "../../subagent/mailbox-mail-drive.js";
import {
  hostOf,
  runWhileAgentBusy,
  type RunnerServices,
  type RunnerState,
} from "./state.js";
import { LOG_NAMESPACE_ROOT } from "../../branding.js";

const tuiLogger = getLogger([LOG_NAMESPACE_ROOT, "tui"]);

export type SubmissionRoute =
  | { kind: "empty" }
  | { kind: "command"; name: string; args: string }
  | { kind: "prompt"; text: string };

/**
 * Decide what a submitted composer line is. A leading `/` means a slash command
 * — it must never reach the model as a prompt, whether it was typed directly or
 * picked from the palette.
 */
export function routeSubmission(raw: string): SubmissionRoute {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "empty" };
  const body = trimmed.startsWith("/") ? trimmed.slice(1).trim() : trimmed;
  if (!trimmed.startsWith("/")) return { kind: "prompt", text: trimmed };
  if (body.length === 0) return { kind: "empty" };
  const sep = body.search(/\s/);
  return sep === -1
    ? { kind: "command", name: body, args: "" }
    : {
        kind: "command",
        name: body.slice(0, sep),
        args: body.slice(sep + 1).trim(),
      };
}

export interface SubmitHandlerDeps {
  dispatchCommand: (name: string, args: string) => void;
  sendPrompt: (
    text: string,
    attachments?: readonly PendingImageAttachment[],
  ) => void;
  /** Consent-by-proceeding hook: runs only for real prompts, never commands. */
  onPromptSubmitted?: () => void;
  /**
   * When true, the next non-command submit is treated as intentional feedback
   * text (bare `/feedback` multi-turn mode) instead of a model prompt.
   */
  isFeedbackCapturePending?: () => boolean;
  /** Consume the pending feedback arm and handle the text; return operator message. */
  onFeedbackText?: (text: string) => string;
  /** Drop a pending multi-turn /feedback arm (empty Enter cancel). */
  cancelFeedbackCapture?: () => void;
  /** Surface a local system notice (feedback thanks / blocked / cancelled). */
  onSystemNotice?: (text: string) => void;
}

/**
 * Composer submit handler. Slash input is dispatched against the command
 * registry instead of being sent to the model. When feedback capture is armed
 * (bare `/feedback`), the next non-command line is captured as survey text.
 *
 * Returns an outcome so the session bridge can keep local-only submits off the
 * agent busy path and out of the mid-run queue.
 */
export type SubmitOutcome = "agent" | "local" | "empty";

/**
 * Classify a composer line without side effects. Local = slash command or
 * armed multi-turn feedback text; empty = no-op (or cancel-feedback); agent =
 * real model turn.
 */
export function classifySubmission(
  text: string,
  options: {
    hasAttachments?: boolean;
    feedbackPending?: boolean;
    feedbackCaptureEnabled?: boolean;
  } = {},
): SubmitOutcome {
  const route = routeSubmission(text);
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
    const route = routeSubmission(text);
    const hasAttachments = attachments !== undefined && attachments.length > 0;
    const feedbackPending = deps.isFeedbackCapturePending?.() === true;
    const feedbackCaptureEnabled = deps.onFeedbackText !== undefined;
    const outcome = classifySubmission(text, {
      hasAttachments,
      feedbackPending,
      feedbackCaptureEnabled,
    });

    // Empty Enter while /feedback is armed cancels instead of trapping the
    // operator until they type free text or /clear.
    if (outcome === "empty") {
      if (feedbackPending) {
        deps.cancelFeedbackCapture?.();
        deps.onSystemNotice?.("Feedback cancelled.");
      }
      return "empty";
    }
    if (route.kind === "command") {
      // Any other slash command drops a bare-/feedback arm so the next
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

/** Text sent alongside an image when the operator attached one without a prompt. */
export const IMAGE_ONLY_PROMPT = "Please inspect the attached image.";

/**
 * Build the inbound message for a genuine operator submit — the real
 * prompt-submit path in the TUI (sendUserPrompt / the "send" command
 * result), with or without attachments. Carries OPERATOR_ORIGINATED_FLAG so
 * director.ts's loop-protection backstop can tell this apart from
 * system-originated sends (compaction continuations, retries, nudges).
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
  // Routed through the shell's notice path rather than straight into the
  // transcript: anything the runner says before the first turn arrives while
  // the landing hero still owns the screen, and a transcript row there wipes
  // the whole composition. Once a session row has ended the landing this is an
  // ordinary system row, so there is no second behaviour to reason about.
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
    state.runError = err instanceof Error ? err.message : String(err);
    if (!providerFailure.presented) {
      systemNotice(
        tuiSendFailureMessage(
          err,
          failure.kind,
          providerFailure.observed,
          attempt,
          providerFailure.error,
        ),
      );
      services.providerFailureAttempts.markPresented(providerFailure);
    }
    setShellRunState(hostOf(state).shell, "idle");
  };
  state.handleSendFailure = handleSendFailure;

  const sendWithAttemptIdentity = async (
    message: InboundMessage,
  ): Promise<boolean> => {
    const attempt = live.attemptIdentity();
    const providerFailure = services.providerFailureAttempts.begin(attempt);
    try {
      await runWhileAgentBusy(state, async () => {
        const result = await live.agentProxy.send(message);
        // An ask-tier call parked on the reactor's approval gate settles the
        // send early; resolve the operator surface here and deliver the
        // decision on the correlationId signal channel so the parked run
        // resumes.
        await services.approvalResume.handle(result);
      });
      return true;
    } catch (error) {
      handleSendFailure(error, attempt, providerFailure);
      return false;
    } finally {
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
      send: (text, pending) => {
        state.sendAborted = false;
        void state.sendWithAttemptIdentity?.(userInboundMessage(text, pending));
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
      deliver: (text, pending) => {
        live.agentProxy.deliver(userInboundMessage(text, pending));
      },
      captureGeneration: services.deliveryGeneration.capture,
      onFailure: (error) =>
        state.handleSendFailure?.(error, live.attemptIdentity(), failureStub()),
    }),
  });
}
