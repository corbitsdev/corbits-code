/**
 * Prompt box: border rules, labels, highlights, attachments, submit/queue/interrupt paths.
 */
import { unlinkSync } from "node:fs";
import { SyntaxStyle } from "@opentui/core";
import { isExitCommand } from "../exit-command.js";
import {
  composePromptActionBarModelLabel,
  type PromptActionBarModelLabelInput,
} from "../components/prompt-action-bar-label.js";
import {
  findDuplicateAttachment,
  readClipboardImage,
  userRowText,
  type PendingImageAttachment,
} from "../image-attachments.js";
import { createSentHistoryBrowse } from "../sent-message-history.js";
import {
  resolvePromptHighlightSpans,
  resolvePromptRecognitionMatcher,
} from "../prompt-recognition.js";
import { RUNTIME_FLASH_MS } from "../runtime-notices.js";
import { composeCostContextMeter, meterEquals } from "../prompt-border.js";
import {
  badgeCount,
  cancelLast,
  clearInterruptFlash,
  enqueue,
  enqueueSteer,
  interrupt,
} from "../session-queue.js";
import { UI } from "../theme.js";

import {
  type AppShell,
  getShellBridgeHooks,
  isLanding,
  shellExitHandlers,
  shellInternals,
  shellPromptImageSource,
  shellRecognitionSource,
} from "./internals.js";
import { streamRowAt } from "./transcript.js";
import {
  appendStreamRow,
  paintChrome,
  paintPromptBorder,
  replaceStreamRowAt,
  setStatusFlash,
} from "./chrome.js";

/** Queue an image for the next submit and reflect it on the notice row. */
export function addPendingAttachment(shell: AppShell, attachment: PendingImageAttachment): void {
  shell.pendingAttachments = [...shell.pendingAttachments, attachment];
  paintChrome(shell);
}

export function clearPendingAttachments(shell: AppShell): void {
  const pending = shell.pendingAttachments;
  shell.pendingAttachments = [];
  paintChrome(shell);
  for (const attachment of pending) {
    const ephemeral = attachment.ephemeralPath;
    if (ephemeral === undefined) continue;
    try {
      unlinkSync(ephemeral);
    } catch (err) {
      if (!isENOENT(err)) throw err;
    }
  }
}

function isENOENT(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

/**
 * Ctrl+P: read an image off the clipboard into the pending set.
 * Resolves false (with a status flash) when nothing was attached.
 */
export async function attachClipboardImage(shell: AppShell): Promise<boolean> {
  const source = shellPromptImageSource.get(shell) ?? readClipboardImage;
  // Sticky until the read resolves — mid-async progress, not a confirmation.
  setStatusFlash(shell, "reading clipboard image…");
  const result = await source();
  // Quitting while the clipboard read is pending tears down the shell's
  // renderables; a stale continuation must not mutate them on resume.
  if (shell.disposed) return false;
  if (!result.ok) {
    setStatusFlash(shell, `image attach failed: ${result.reason}`, {
      ttlMs: RUNTIME_FLASH_MS,
    });
    return false;
  }
  const duplicate = findDuplicateAttachment(shell.pendingAttachments, result.attachment);
  if (duplicate !== undefined) {
    setStatusFlash(shell, `${duplicate.name} is already attached`, {
      ttlMs: RUNTIME_FLASH_MS,
    });
    return false;
  }
  addPendingAttachment(shell, result.attachment);
  setStatusFlash(shell, `attached ${result.attachment.name}`, {
    ttlMs: RUNTIME_FLASH_MS,
  });
  return true;
}

/** Seed the Up/Down recall list (host replays persisted session messages). */
export function setSentMessageHistory(shell: AppShell, sent: readonly string[]): void {
  shell.sentHistory = createSentHistoryBrowse(sent);
}

function recordSentMessage(shell: AppShell, text: string): void {
  shell.sentHistory = createSentHistoryBrowse([...shell.sentHistory.sent, text]);
}

/** Publish the `profile · model · effort` label carried by the top border. */
export function setPromptModelLabel(shell: AppShell, input: PromptActionBarModelLabelInput): void {
  const label = composePromptActionBarModelLabel(input) ?? null;
  if (label === shell.modelLabel) return;
  shell.modelLabel = label;
  paintPromptBorder(shell);
}

/** Publish the working directory and git branch carried by the bottom border. */
export function setPromptWorkspace(
  shell: AppShell,
  input: { readonly cwd?: string; readonly branch?: string | null },
): void {
  const cwd = input.cwd ?? shell.workspace.cwd;
  const branch = input.branch === undefined ? shell.workspace.branch : input.branch;
  if (cwd === shell.workspace.cwd && branch === shell.workspace.branch) return;
  shell.workspace = { cwd, branch };
  paintPromptBorder(shell);
}

/**
 * Publish the cost/context meter carried by the bottom border. Driven by
 * usage changes (a completed turn), not a timer: the percentage does not move
 * between turns, so there is nothing to animate on the idle tick.
 */
export function setPromptCostContext(
  shell: AppShell,
  input: {
    readonly contextPercentUsed: number | null;
    readonly costLabel?: string | null;
    readonly contextIsEstimate: boolean;
  },
): void {
  const meter = composeCostContextMeter(input);
  if (meterEquals(meter, shell.costContext)) return;
  shell.costContext = meter;
  paintPromptBorder(shell);
}

let cachedPromptSyntaxStyle: SyntaxStyle | null = null;

let cachedPromptRecognizedStyleId: number | null = null;

/**
 * The style registry backing the prompt's highlights, plus the one style id
 * this feature uses. Lazy for the same reason as `transcriptSyntaxStyle`:
 * construction reaches into the native render lib.
 */
function promptRecognizedStyleId(): number {
  if (cachedPromptSyntaxStyle === null) {
    cachedPromptSyntaxStyle = SyntaxStyle.fromStyles({
      recognized: { fg: UI.action },
    });
  }
  if (cachedPromptRecognizedStyleId === null) {
    cachedPromptRecognizedStyleId = cachedPromptSyntaxStyle.resolveStyleId("recognized") ?? 0;
  }
  return cachedPromptRecognizedStyleId;
}

const promptHighlightedValue = new WeakMap<AppShell, string>();

/**
 * Re-mark leading slash commands and @mentions in the prompt. Runs once per frame
 * (see `onFrame` in `createShell`), and only does anything when the prompt's
 * text actually changed since the last frame — typing that doesn't touch a
 * token, and every non-typing frame, is a no-op string comparison.
 */
export function syncPromptHighlights(shell: AppShell): void {
  const source = shellRecognitionSource.get(shell);
  if (source === undefined) return;
  const value = shell.prompt.value;
  if (promptHighlightedValue.get(shell) === value) return;
  promptHighlightedValue.set(shell, value);

  const styleId = promptRecognizedStyleId();
  shell.prompt.syntaxStyle = cachedPromptSyntaxStyle;
  shell.prompt.clearAllHighlights();
  const matcher = resolvePromptRecognitionMatcher(source);
  for (const span of resolvePromptHighlightSpans(value, matcher)) {
    shell.prompt.addHighlightByCharRange({ start: span.start, end: span.end, styleId });
  }
}

/**
 * Surface a runtime/load notice without stealing the landing hero.
 *
 * MCP connection failures, hook failures and similar startup chatter used to
 * call `appendStreamRow` → `clearLandingMark`, wiping the mountain the moment
 * anything went wrong on load (CL-5618 / CL-5600). While the landing is still
 * mounted the wording rides the notice strip and the row is held for flush
 * once a real session row ends the landing; after that it is a normal system
 * row.
 *
 * Every producer of a system-class row belongs here rather than at
 * `appendStreamRow`. CL-5618 fixed the MCP and hook producers one at a time
 * and the plugin producer kept the defect, which is what per-call-site rules
 * buy you. Reaching for `appendStreamRow` directly is the bug.
 */
/**
 * Suspend or resume the shell's own key/paste/submit handling. A full-screen
 * surface that borrows this renderer (the inline provider connect) owns the
 * keyboard for its lifetime; without this, Ctrl+C during a sign-in would
 * also reach the shell and interrupt the running agent.
 */
export function setShellInputSuspended(shell: AppShell, suspended: boolean): void {
  const bag = shellInternals(shell);
  if (bag !== undefined) bag.inputSuspended = suspended;
}

export function surfaceSystemNotice(shell: AppShell, text: string): void {
  if (isLanding(shell)) {
    const bag = shellInternals(shell);
    if (bag !== undefined) {
      bag.landingDeferredRows.push({ role: "system", text });
    }
    setStatusFlash(shell, text);
    return;
  }
  appendStreamRow(shell, { role: "system", text });
}

/**
 * Submit the prompt. Product chords (CL-6290):
 *  - "steer": mid-run Enter — soft steer at the next tool.boundary.
 *  - "queue": mid-run Alt+Enter — follow-up; deliver only when the run goes
 *    idle. Idle Alt+Enter is a no-op at the key handler (never reaches here
 *    with kind "queue" while idle from the product chord).
 *  - "reinject": hard-stop and restart from this message. No product chord
 *    wires this anymore; kept for tests / direct API callers. No-op when the
 *    run isn't busy, or the prompt is empty.
 *  - Idle Enter (either queue or steer kind) goes straight through; "kind"
 *    only matters while a run is in flight.
 */
export function submitPrompt(
  shell: AppShell,
  kind: "queue" | "steer" | "reinject" = "queue",
): void {
  const text = shell.prompt.value;
  const t = text.trim();
  const attachments = shell.pendingAttachments;
  if (t.length === 0 && attachments.length === 0) {
    // Empty Enter still reaches the exclusive host so multi-turn /feedback
    // can cancel; non-exclusive shells have nothing to do with a blank line.
    const hooks = getShellBridgeHooks(shell);
    if (hooks?.exclusive) {
      hooks.onSubmit(text, "immediate", attachments);
    }
    return;
  }
  // Reinject is unwired from product chords; still guard idle for API callers.
  if (kind === "reinject" && shell.session.run !== "busy") return;
  // Follow-up idle no-op lives on the Alt+Enter key handler (kind "queue" is
  // also the default for submitPrompt and must still send when idle).

  // Shell/REPL muscle memory: a bare `exit` or `quit` quits rather than being
  // sent to the model. Attachments mean the operator meant it as a message.
  if (attachments.length === 0 && isExitCommand(t)) {
    const onExit = shellExitHandlers.get(shell);
    if (onExit !== undefined) {
      shell.prompt.value = "";
      onExit();
      return;
    }
  }

  if (t.length > 0) recordSentMessage(shell, t);
  const hooks = getShellBridgeHooks(shell);
  if (hooks?.exclusive) {
    shell.prompt.value = "";
    clearPendingAttachments(shell);
    const resolved: "queue" | "steer" | "immediate" | "reinject" =
      kind === "reinject" ? "reinject" : shell.session.run === "idle" ? "immediate" : kind;
    hooks.onSubmit(text, resolved, attachments);
    return;
  }

  if (kind === "reinject") {
    // Unwired from product chords (CL-6290); kept for tests / direct callers.
    shell.session = interrupt(shell.session);
    shell.prompt.value = "";
    clearPendingAttachments(shell);
    appendStreamRow(shell, {
      role: "system",
      text: "stop — restarting from your message",
      meta: "stop",
    });
    appendStreamRow(shell, {
      role: "user",
      text: userRowText(t, attachments),
      meta: "reinject",
    });
    paintChrome(shell);
    return;
  }

  if (shell.session.run === "idle") {
    appendStreamRow(shell, { role: "user", text: t });
    shell.prompt.value = "";
    clearPendingAttachments(shell);
    return;
  }

  shell.session =
    kind === "steer"
      ? enqueueSteer(shell.session, t, undefined, attachments)
      : enqueue(shell.session, t, "queue", undefined, attachments);
  const queued = shell.session.items[shell.session.items.length - 1];
  shell.prompt.value = "";
  clearPendingAttachments(shell);
  // Show the message itself, not the internal transition ("queue +1 →
  // pending N") — the notice row already carries the depth once, in plain
  // language, so this row's job is making the pending item identifiable.
  appendStreamRow(shell, {
    role: "user",
    text: userRowText(t, attachments),
    meta: kind === "steer" ? "steer" : "queue",
    ...(queued !== undefined ? { queueItemId: queued.id } : {}),
  });
  paintChrome(shell);
}

/**
 * Find the transcript row a still-pending queue/steer item echoed, so a
 * cancel can retract it instead of leaving a message tagged "queue" that will
 * never dispatch. Absolute index, matching `replaceStreamRowAt`.
 */
function findQueueRowIndex(shell: AppShell, queueItemId: string): number | undefined {
  for (let local = shell.streamLog.length - 1; local >= 0; local--) {
    if (shell.streamLog[local]?.queueItemId === queueItemId) {
      return shell.streamLogBase + local;
    }
  }
  return undefined;
}

/**
 * Cancel the most recently queued or steered message (last-only: see
 * `cancelLast`'s doc comment for why picking an earlier item is out of
 * scope). Retracts it from the queue and rewrites its transcript row so the
 * readout never shows a message tagged "queue"/"steer" that will not send.
 */
export function applyShellCancelLast(shell: AppShell): void {
  const { state, item } = cancelLast(shell.session);
  if (item === null) return;
  shell.session = state;
  const index = findQueueRowIndex(shell, item.id);
  if (index !== undefined) {
    const row = streamRowAt(shell, index);
    if (row !== undefined) {
      // `cancelled` stays a flag, not a `text` rewrite — `paintStreamRow`
      // owns turning it into the "[cancelled]" prefix, so `row.text` still
      // holds what the operator actually typed for anything else that reads
      // it (copy mode, a resumed transcript).
      replaceStreamRowAt(shell, index, { ...row, meta: "cancelled", cancelled: true });
    }
  }
  paintChrome(shell);
}

/** Local interrupt mutation (no bridge re-entry). */
export function applyShellInterrupt(shell: AppShell): void {
  const had = badgeCount(shell.session);
  shell.session = interrupt(shell.session);
  shell.prompt.value = "";
  appendStreamRow(shell, {
    role: "system",
    text: had > 0 ? `${had} pending kept` : "stopped",
    meta: "stop",
  });
  paintChrome(shell);
}

/** Ctrl+C interrupt path: keep pending, flash, idle. */
export function interruptShell(shell: AppShell): void {
  const hooks = getShellBridgeHooks(shell);
  if (hooks?.exclusive) {
    hooks.onInterrupt();
    return;
  }
  applyShellInterrupt(shell);
}

export function clearShellInterruptFlash(shell: AppShell): void {
  shell.session = clearInterruptFlash(shell.session);
  paintChrome(shell);
}
