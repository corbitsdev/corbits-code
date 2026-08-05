import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { Agent } from "@intx/agent";
import type { InboundMessage } from "@intx/types/runtime";
import type { OutboundUserMessage } from "../message-types.js";
import { resolveAtMentions } from "../mention-resolution.js";
import type { AgentStreamView } from "../use-stream.js";
import { classifyAgentSendFailure, shouldSettleUiAfterSendFailure } from "../session-chrome.js";
import { INFERENCE_ABORT_USER_STOP } from "../../inference-abort.js";
import { appendSentMessage, loadSentMessages } from "../../session/sent-messages.js";
import { createSentHistoryBrowse, resetSentHistoryBrowse, type SentHistoryBrowse } from "../sent-message-history.js";
import { findImagePathMentions, imageAttachmentFromPath, type PendingImageAttachment } from "../image-attachments.js";
import { isExitCommand } from "../exit-command.js";
import { CodexAuthError } from "../../auth/codex/session.js";
import { XaiAuthError } from "../../auth/xai/session.js";
import type { ScrollController } from "./use-scroll.js";
import type { GateController } from "./use-gates.js";
import type { SubAgentSessionStore } from "../../subagent/index.js";

export type UseMessagePipelineArgs = {
  cwd: string;
  agent: Agent;
  getSessionId: (() => string) | undefined;
  exit: () => void;
  onFirstUserMessage: (() => void) | undefined;
  onInterrupt: (() => void) | undefined;
  onNewSession: (() => void) | undefined;
  onAgentError: ((err: unknown) => void) | undefined;
  skipInitialTask: boolean;
  initialTask: string;
  state: AgentStreamView;
  stateRef: { current: AgentStreamView };
  scroll: ScrollController;
  gates: GateController;
  subAgentSessions: SubAgentSessionStore | undefined;
  activeSubAgentsRef: { current: readonly { status: string }[] };
  hasRunningSubAgentSessions: () => boolean;
  pendingQueueRef: { current: OutboundUserMessage[] };
  setQueuedCount: Dispatch<SetStateAction<number>>;
  pendingImages: PendingImageAttachment[];
  setPendingImages: Dispatch<SetStateAction<PendingImageAttachment[]>>;
  setCommandMessage: Dispatch<SetStateAction<string | null>>;
  setSentHistoryBrowse: Dispatch<SetStateAction<SentHistoryBrowse>>;
  promptCodexRelogin: (name: string) => void;
  promptXaiRelogin: (name: string) => void;
  setExpandedTools: Dispatch<SetStateAction<ReadonlySet<string>>>;
  setInputValue: Dispatch<SetStateAction<string>>;
  setEnteredSessionId: Dispatch<SetStateAction<string | null>>;
  setAgentsNavOpen: Dispatch<SetStateAction<boolean>>;
  setAgentsNavIndex: Dispatch<SetStateAction<number>>;
  forceRender: Dispatch<SetStateAction<number>>;
  sendMessageRef: { current: (message: OutboundUserMessage) => void };
  requestStopRef: { current: () => void };
};

export type MessagePipelineController = {
  sendMessage: (message: OutboundUserMessage) => void;
  requestStop: () => void;
  startNewSession: () => void;
  startNewSessionRef: { current: () => void };
  prepareOutboundMessage: (
    message: string,
    baseAttachments: PendingImageAttachment[],
  ) => Promise<OutboundUserMessage>;
  handleSend: (message: string) => void;
  handleInterrupt: (message: string) => void;
  sendAbortRef: { current: AbortController | null };
  sendCounterRef: { current: number };
  lastSentMessageRef: { current: string };
  quotaAutoRetryFiredRef: { current: boolean };
};

export function useMessagePipeline({
  cwd,
  agent,
  getSessionId,
  exit,
  onFirstUserMessage,
  onInterrupt,
  onNewSession,
  onAgentError,
  skipInitialTask,
  initialTask,
  state,
  stateRef,
  scroll,
  gates,
  subAgentSessions,
  activeSubAgentsRef,
  hasRunningSubAgentSessions,
  pendingQueueRef,
  setQueuedCount,
  pendingImages,
  setPendingImages,
  setCommandMessage,
  setSentHistoryBrowse,
  promptCodexRelogin,
  promptXaiRelogin,
  setExpandedTools,
  setInputValue,
  setEnteredSessionId,
  setAgentsNavOpen,
  setAgentsNavIndex,
  forceRender,
  sendMessageRef,
  requestStopRef,
}: UseMessagePipelineArgs): MessagePipelineController {
  // One controller per in-flight send so Ctrl+C / double-Esc can abort the
  // active run. Aborting rejects the send promise; the reactor's current cycle
  // finishes but no new cycle starts, which is the "Stopping" → "Stopped" path.
  const sendAbortRef = useRef<AbortController | null>(null);
  const didSendInitial = useRef(false);
  const firstUserMessageFired = useRef(false);
  // Incremented on every send so useSpinner can reset its elapsed clock per turn.
  const sendCounterRef = useRef(0);
  const lastSentMessageRef = useRef<string>("");
  const quotaAutoRetryFiredRef = useRef(false);

  sendMessageRef.current = (message: OutboundUserMessage) => {
    lastSentMessageRef.current = message.text;
    const trimmed = message.text.trim();
    if (trimmed.length > 0 && getSessionId !== undefined) {
      const sid = getSessionId();
      void appendSentMessage(cwd, sid, trimmed).then(() => {
        setSentHistoryBrowse((prev) => resetSentHistoryBrowse([...prev.sent, trimmed]));
      });
    }
    quotaAutoRetryFiredRef.current = false;
    sendCounterRef.current += 1;
    state.markRunning();
    scroll.scrollToBottom();

    // Append the user message to the transcript immediately (optimistic echo).
    // This ensures the input is visible even when send() is delayed by pre-send
    // work such as Codex/XAI token refresh. The subsequent message.received will
    // no-op the duplicate push.
    const displayContent = message.text.length > 0 ? message.text : "Please inspect the attached image.";
    const attachmentText = message.attachments.length > 0
      ? `\n[Attached ${message.attachments.length} image${message.attachments.length === 1 ? "" : "s"}: ${message.attachments.map((att) => att.name).join(", ")}]`
      : "";
    state.appendUserMessage(`${displayContent}${attachmentText}`);

    // Nudge a re-render so the in-flight indicator and interval timer activate
    // immediately rather than waiting for the first event from the new run.
    forceRender((n) => n + 1);
    const controller = new AbortController();
    sendAbortRef.current = controller;
    const inbound: InboundMessage = {
      ref: { uid: 1, mailbox: "INBOX" },
      headers: {
        from: "user@local",
        to: ["agent@local"],
        date: new Date().toISOString(),
        messageId: `<${crypto.randomUUID()}@local>`,
        interchangeType: "conversation.message",
      },
      flags: [],
      signatureStatus: "missing",
      content: message.text.length > 0 ? message.text : "Please inspect the attached image.",
      ...(message.attachments.length > 0 ? { attachments: message.attachments } : {}),
    };
    agent.send(inbound, { signal: controller.signal }).catch((err: unknown) => {
      const kind = classifyAgentSendFailure(
        err,
        controller.signal.aborted,
        (e): e is CodexAuthError => e instanceof CodexAuthError,
        (e): e is XaiAuthError => e instanceof XaiAuthError,
      );
      if (kind === "abort") return;
      if (shouldSettleUiAfterSendFailure(kind)) {
        state.requestStop();
        gates.resetGates();
        forceRender((n) => n + 1);
      }
      if (kind === "codex_auth") {
        promptCodexRelogin((err as CodexAuthError).profile);
        return;
      }
      if (kind === "xai_auth") {
        promptXaiRelogin((err as XaiAuthError).profile);
        return;
      }
      onAgentError?.(err);
    });
  };
  const sendMessage = (message: OutboundUserMessage) => sendMessageRef.current(message);

  const requestStop = () => {
    quotaAutoRetryFiredRef.current = true;
    sendAbortRef.current?.abort(INFERENCE_ABORT_USER_STOP);
    // Parent stop must cancel live children too: aborting the parent send signal
    // is linked into each task's child controller, and cancelAll flips session
    // status + fires registerCancel hooks that close child agents.
    subAgentSessions?.cancelAll("Parent stop");
    onInterrupt?.();
    state.requestStop();
    gates.resetGates();
    // Discard queued messages — a stopped run should not silently replay them
    // into the next session's first turn when connector.reply eventually fires.
    pendingQueueRef.current.length = 0;
    setQueuedCount(0);
    // Clear the last-sent prompt so the quota auto-retry loop cannot resubmit
    // the interrupted turn once its retry-after window elapses; the agent is
    // rebuilt from the persisted store on interrupt, and replaying the prompt
    // on top of that would duplicate the turn's tool executions.
    lastSentMessageRef.current = "";
    forceRender((n) => n + 1);
  };

  requestStopRef.current = requestStop;

  const startNewSessionRef = useRef<() => void>(() => undefined);
  startNewSessionRef.current = () => {
    sendAbortRef.current?.abort();
    // Cancel live workers before clearing the strip so child reactors close
    // instead of continuing after /clear.
    subAgentSessions?.cancelAll("New session");
    state.clear();
    gates.resetGates();
    setExpandedTools(new Set());
    pendingQueueRef.current.length = 0;
    setQueuedCount(0);
    // Same guard as requestStop: a cleared session must not auto-resubmit a
    // prior prompt when the quota retry interval is still polling.
    lastSentMessageRef.current = "";
    quotaAutoRetryFiredRef.current = true;
    setInputValue("");
    setEnteredSessionId(null);
    setAgentsNavOpen(false);
    setAgentsNavIndex(0);
    subAgentSessions?.clear();
    onNewSession?.();
    if (getSessionId !== undefined) {
      void loadSentMessages(cwd, getSessionId()).then((sent) => {
        setSentHistoryBrowse(createSentHistoryBrowse(sent));
      });
    } else {
      setSentHistoryBrowse(createSentHistoryBrowse([]));
    }
    scroll.scrollToBottom();
    forceRender((n) => n + 1);
  };
  const startNewSession = () => startNewSessionRef.current();

  // Send the initial task once the App (and its gate listeners) is mounted, so
  // the run is driven through the same abortable path as interactive sends.
  useEffect(() => {
    if (getSessionId === undefined) return;
    void loadSentMessages(cwd, getSessionId()).then((sent) => {
      setSentHistoryBrowse(createSentHistoryBrowse(sent));
    });
  }, [cwd, getSessionId]);

  useEffect(() => {
    if (didSendInitial.current) return;
    didSendInitial.current = true;
    if (skipInitialTask) return;
    if (initialTask.length > 0) sendMessage({ text: initialTask, attachments: [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prepareOutboundMessage = async (
    message: string,
    baseAttachments: PendingImageAttachment[],
  ): Promise<OutboundUserMessage> => {
    let text = message;
    const mentions = findImagePathMentions(message, cwd);
    const loaded = await Promise.all(mentions.map((mention) => imageAttachmentFromPath(mention.path)));
    const attachments = [...baseAttachments];
    for (let i = 0; i < mentions.length; i++) {
      const mention = mentions[i];
      const result = loaded[i];
      if (mention === undefined || result === undefined || !result.ok) continue;
      attachments.push(result.attachment);
      text = text.replace(mention.raw, `[Attached image: ${result.attachment.name}]`);
    }
    return { text: await resolveAtMentions(text, cwd), attachments };
  };

  const handleSend = (message: string) => {
    if (isExitCommand(message)) {
      exit();
      return;
    }
    if (!firstUserMessageFired.current) {
      firstUserMessageFired.current = true;
      onFirstUserMessage?.();
    }
    setCommandMessage(null);
    const attachments = pendingImages;
    setPendingImages([]);
    void prepareOutboundMessage(message, attachments).then((outbound) => {
      // Read live state from the ref — prepareOutboundMessage is async (it does
      // @-mention resolution + disk I/O), so the closed-over state.isProcessing
      // can be stale by the time this resolves. A previous turn can finish and
      // drain the queue during the async window; reading the stale value would
      // then queue a message nothing will ever drain, leaving the UI stuck.
      const childWorkActive =
        activeSubAgentsRef.current.length > 0 || hasRunningSubAgentSessions();
      if (stateRef.current.isProcessing || childWorkActive) {
        pendingQueueRef.current.push(outbound);
        setQueuedCount((c) => c + 1);
        return;
      }
      sendMessage(outbound);
    });
  };

  const handleInterrupt = (message: string) => {
    if (isExitCommand(message)) {
      requestStop();
      exit();
      return;
    }
    setCommandMessage(null);
    // requestStop must fire synchronously before any async work so the abort
    // signal reaches the in-flight HTTP request before at-mention resolution
    // has a chance to yield, preventing a stale connector.reply from racing
    // the new turn's state.
    requestStop();
    const attachments = pendingImages;
    setPendingImages([]);
    void prepareOutboundMessage(message, attachments).then(sendMessage);
  };

  return {
    sendMessage,
    requestStop,
    startNewSession,
    startNewSessionRef,
    prepareOutboundMessage,
    handleSend,
    handleInterrupt,
    sendAbortRef,
    sendCounterRef,
    lastSentMessageRef,
    quotaAutoRetryFiredRef,
  };
}
