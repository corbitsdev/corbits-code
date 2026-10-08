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
import {
  createSentHistoryBrowse,
  sentHistoryOnEdit,
} from "../sent-message-history.js";
import { stripUneditedSlashHint } from "../command-catalog.js";
import {
  resolvePromptHighlightSpans,
  resolvePromptRecognitionMatcher,
} from "../prompt-recognition.js";
import { RUNTIME_FLASH_MS } from "../runtime-notices.js";
import { composeCostContextMeter, meterEquals } from "../prompt-border.js";
import { pendingWindowStart } from "../pending-column.js";
import { promptCaretAtFirstRow } from "../prompt-input.js";
import {
  badgeCount,
  cancelItem,
  cancelLast,
  enqueue,
  enqueueSteer,
  interrupt,
} from "../delivery-queue.js";
import { UI, onThemeChange } from "../theme.js";

import {
  type AppShell,
  getShellBridgeHooks,
  isLanding,
  shellExitHandlers,
  shellInternals,
  shellPromptImageSource,
  shellRecognitionSource,
} from "./internals.js";
import {
  appendStreamRow,
  paintChrome,
  paintPromptBorder,
  setStatusFlash,
} from "./chrome.js";
import { resolvePaletteCatalog } from "./palette.js";

/** Queue an image for the next submit and reflect it on the notice row. */
export function addPendingAttachment(
  shell: AppShell,
  attachment: PendingImageAttachment,
): void {
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
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "ENOENT"
  );
}

/** Ctrl+P: read a clipboard image into the pending set. False if none. */
export async function attachClipboardImage(shell: AppShell): Promise<boolean> {
  const source = shellPromptImageSource.get(shell) ?? readClipboardImage;
  // Sticky until the read resolves — mid-async progress, not a confirmation.
  setStatusFlash(shell, "reading clipboard image…");
  const result = await source();
  // Quitting mid-read tears down the shell's renderables; a stale
  // continuation must not mutate them on resume.
  if (shell.disposed) return false;
  if (!result.ok) {
    setStatusFlash(shell, `image attach failed: ${result.reason}`, {
      ttlMs: RUNTIME_FLASH_MS,
    });
    return false;
  }
  const duplicate = findDuplicateAttachment(
    shell.pendingAttachments,
    result.attachment,
  );
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
export function setSentMessageHistory(
  shell: AppShell,
  sent: readonly string[],
): void {
  shell.sentHistory = createSentHistoryBrowse(sent);
}

function recordSentMessage(shell: AppShell, text: string): void {
  shell.sentHistory = createSentHistoryBrowse([
    ...shell.sentHistory.sent,
    text,
  ]);
}

/** Publish the `profile · model · effort` label carried by the top border. */
export function setPromptModelLabel(
  shell: AppShell,
  input: PromptActionBarModelLabelInput,
): void {
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
  const branch =
    input.branch === undefined ? shell.workspace.branch : input.branch;
  if (cwd === shell.workspace.cwd && branch === shell.workspace.branch) return;
  shell.workspace = { cwd, branch };
  paintPromptBorder(shell);
}

/**
 * Publish the cost/context meter on the bottom border. Updated on usage
 * changes (a completed turn), not a timer: the percentage is static between
 * turns.
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

let promptStyleGeneration = 0;

const promptHighlightGenerations = new WeakMap<AppShell, number>();

onThemeChange(() => {
  cachedPromptSyntaxStyle = null;
  cachedPromptRecognizedStyleId = null;
  promptStyleGeneration += 1;
});

/**
 * Highlight style registry plus the one style id this feature uses. Lazy
 * like `transcriptSyntaxStyle`: construction reaches into the native render
 * lib.
 */
function promptRecognizedStyleId(): number {
  if (cachedPromptSyntaxStyle === null) {
    cachedPromptSyntaxStyle = SyntaxStyle.fromStyles({
      recognized: { fg: UI.action },
    });
  }
  if (cachedPromptRecognizedStyleId === null) {
    cachedPromptRecognizedStyleId =
      cachedPromptSyntaxStyle.resolveStyleId("recognized") ?? 0;
  }
  return cachedPromptRecognizedStyleId;
}

const promptHighlightedValue = new WeakMap<AppShell, string>();

/**
 * Re-mark leading slash commands and @mentions. Runs once per frame (see
 * `onFrame`) and no-ops unless the text changed since the last frame — a
 * miss is just a plain string compare.
 */
export function syncPromptHighlights(shell: AppShell): void {
  const source = shellRecognitionSource.get(shell);
  if (source === undefined) return;
  const value = shell.prompt.value;
  if (
    promptHighlightedValue.get(shell) === value &&
    promptHighlightGenerations.get(shell) === promptStyleGeneration
  )
    return;
  promptHighlightedValue.set(shell, value);
  promptHighlightGenerations.set(shell, promptStyleGeneration);

  const styleId = promptRecognizedStyleId();
  shell.prompt.syntaxStyle = cachedPromptSyntaxStyle;
  shell.prompt.clearAllHighlights();
  const matcher = resolvePromptRecognitionMatcher(source);
  for (const span of resolvePromptHighlightSpans(value, matcher)) {
    shell.prompt.addHighlightByCharRange({
      start: span.start,
      end: span.end,
      styleId,
    });
  }
}

/**
 * Suspend/resume shell key/paste/submit handling. A full-screen surface
 * borrowing this renderer (the inline provider connect) owns the keyboard
 * for its lifetime, so Ctrl+C during a sign-in can't interrupt the agent.
 */
export function setShellInputSuspended(
  shell: AppShell,
  suspended: boolean,
): void {
  const bag = shellInternals(shell);
  if (bag !== undefined) bag.inputSuspended = suspended;
}

/**
 * Surface a runtime/load notice without stealing the landing hero: while the
 * landing is mounted the wording rides the notice strip and is flushed when
 * a real session row ends the landing; afterwards it is a normal system row.
 * System-class rows belong here, not at `appendStreamRow`.
 */
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
 * Submit the prompt. Product chords:
 *  - "steer": mid-run Enter — soft steer at the next tool boundary.
 *  - "queue": mid-run Alt+Enter — follow-up, delivered only when the run
 *    goes idle (idle Alt+Enter is a no-op).
 *  - "reinject": hard-stop and restart from this message. No product chord
 *    wires it; for tests / direct API callers. No-op unless the run is busy
 *    and the prompt non-empty.
 *  - Idle Enter (either kind) sends directly; "kind" only matters while a
 *    run is in flight.
 */
export function submitPrompt(
  shell: AppShell,
  kind: "queue" | "steer" | "reinject" = "queue",
): void {
  // A Tab-accepted free-form hint is placeholder text; bare Enter must
  // dispatch the command, not submit the literal. The strip is shape-only —
  // the untouched selection is lost to an arrow key — so only the exact
  // `/id <hint>` match strips; real arguments never equal the hint.
  const hintBase = stripUneditedSlashHint(
    resolvePaletteCatalog(shell),
    shell.prompt.value,
  );
  if (hintBase !== null) {
    shell.prompt.value = hintBase;
    shell.prompt.cursorOffset = hintBase.length;
    shell.sentHistory = sentHistoryOnEdit(shell.sentHistory);
  }
  const text = shell.prompt.value;
  const t = text.trim();
  const attachments = shell.pendingAttachments;
  if (t.length === 0 && attachments.length === 0) {
    // Empty Enter still reaches the exclusive host so multi-turn /feedback
    // can cancel.
    const hooks = getShellBridgeHooks(shell);
    if (hooks?.exclusive) {
      hooks.onSubmit(text, "immediate", attachments);
    }
    return;
  }
  // Still guard idle for API callers.
  if (kind === "reinject" && shell.session.run !== "busy") return;
  // Idle no-op lives on the Alt+Enter handler; "queue" is the default kind
  // and must still send when idle.

  // Shell/REPL muscle memory: bare `exit`/`quit` quits rather than sending;
  // attachments mean the operator meant it as a message.
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
      kind === "reinject"
        ? "reinject"
        : shell.session.run === "idle"
          ? "immediate"
          : kind;
    hooks.onSubmit(text, resolved, attachments);
    return;
  }

  if (kind === "reinject") {
    // Kept for tests / direct callers.
    shell.session = interrupt(shell.session);
    shell.prompt.value = "";
    clearPendingAttachments(shell);
    // Reuse the pause wording ("pending kept"/"stopped") plus the arming-window
    // flash: queued work only delivers on the operator's next explicit send,
    // and a second Ctrl+C quits.
    appendStreamRow(shell, {
      role: "system",
      text:
        badgeCount(shell.session) > 0
          ? `${badgeCount(shell.session)} pending kept — press ctrl+c again to exit`
          : "stopped — press ctrl+c again to exit",
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
  shell.prompt.value = "";
  clearPendingAttachments(shell);
  // No transcript echo while pending: the item sits in the pending column
  // and lands as an ordinary user row when it delivers.
  paintChrome(shell);
}

/**
 * Pop the most recently queued or steered message back into the composer
 * (last-only, see `cancelLast`). An empty prompt gets the item's text and
 * attachments back for editing and resend; mid-compose it is dropped so a
 * merge into an in-progress draft cannot send two messages as one.
 */
export function applyShellCancelLast(shell: AppShell): void {
  const { state, item } = cancelLast(shell.session);
  if (item === null) return;
  shell.session = state;
  if (shell.prompt.value.length === 0) {
    shell.prompt.value = item.text;
    shell.prompt.cursorOffset = item.text.length;
    if (item.attachments !== undefined && item.attachments.length > 0) {
      shell.pendingAttachments = [
        ...shell.pendingAttachments,
        ...item.attachments,
      ];
    }
  }
  paintChrome(shell);
}

/** Index of the selected pending item, or -1 when nothing is selected. */
function pendingSelIndex(shell: AppShell): number {
  const selId = shellInternals(shell)?.pendingSelId;
  if (selId === undefined || selId === null) return -1;
  return shell.session.items.findIndex((item) => item.id === selId);
}

/** True while the pending column, not the prompt, owns the keys. */
export function pendingSelectionActive(shell: AppShell): boolean {
  return pendingSelIndex(shell) >= 0;
}

/** End pending selection (if any). Returns whether a selection was dropped. */
export function clearPendingSelection(shell: AppShell): boolean {
  const bag = shellInternals(shell);
  if (bag === undefined || bag.pendingSelId === null) return false;
  bag.pendingSelId = null;
  paintChrome(shell);
  return true;
}

/**
 * ↑/↓ on the pending column. ↑ from the prompt's top edge selects the newest
 * held item (nearest the box); ↑/↓ walk the column; ↓ past the last row
 * hands the key back to the prompt's motion. Only rows the column paints can
 * be selected. Returns whether the key was claimed.
 */
export function applyPendingNav(shell: AppShell, delta: -1 | 1): boolean {
  const bag = shellInternals(shell);
  if (bag === undefined) return false;
  const items = shell.session.items;
  const itemRows = Math.max(0, shell.layout.heights.pending - 1);
  const floor = pendingWindowStart(items.length, itemRows);
  const sel = pendingSelIndex(shell);
  if (delta === -1) {
    // Nothing visible to land on: the column folded or has no grant.
    if (items.length === 0 || items.length - 1 < floor) return false;
    // Entering the column only happens from the buffer's top row, so ↑ inside
    // a multi-row draft still moves the caret rather than stealing focus.
    if (sel === -1 && !promptCaretAtFirstRow(shell.prompt)) return false;
    const next = sel === -1 ? items.length - 1 : Math.max(floor, sel - 1);
    bag.pendingSelId = items[next]?.id ?? null;
    paintChrome(shell);
    return true;
  }
  if (sel === -1) return false;
  bag.pendingSelId =
    sel >= items.length - 1 ? null : (items[sel + 1]?.id ?? null);
  paintChrome(shell);
  return true;
}

/**
 * No-runtime leave through the selected row: kill the selected item out of
 * the queue. Same contract as `applyShellCancelLast`: an empty prompt gets
 * the item back for editing; mid-draft it is dropped, not merged.
 */
function popSelectedToPrompt(shell: AppShell): void {
  const bag = shellInternals(shell);
  const sel = pendingSelIndex(shell);
  if (bag === undefined || sel < 0) return;
  const id = shell.session.items[sel]?.id;
  if (id === undefined) return;
  const { state, item: popped } = cancelItem(shell.session, id);
  if (popped === null) return;
  shell.session = state;
  bag.pendingSelId = null;
  if (shell.prompt.value.length === 0) {
    shell.prompt.value = popped.text;
    shell.prompt.cursorOffset = popped.text.length;
    shell.pendingAttachments = [
      ...shell.pendingAttachments,
      ...(popped.attachments ?? []),
    ];
  }
  paintChrome(shell);
}

/**
 * Enter on a selected pending item: kill it out of the queue and deliver now
 * through the runtime, skipping its boundary/idle wait. With no runtime
 * attached there is nothing to deliver to, so it falls back to
 * `popSelectedToPrompt`.
 */
export function applyPendingForcePush(shell: AppShell): void {
  const bag = shellInternals(shell);
  const sel = pendingSelIndex(shell);
  if (bag === undefined || sel < 0) return;
  const item = shell.session.items[sel];
  if (item === undefined) return;
  const hooks = getShellBridgeHooks(shell);
  if (hooks?.exclusive === true && hooks.onForceDeliver !== undefined) {
    bag.pendingSelId = null;
    hooks.onForceDeliver(item.id);
    // The hook owns the delivery repaint; this pass covers stubs that don't.
    paintChrome(shell);
    return;
  }
  popSelectedToPrompt(shell);
}

/**
 * Ctrl+G on a selected pending item: cancel that row, not the newest. It
 * only cancels, never delivers.
 */
export function applyPendingCancelSelected(shell: AppShell): void {
  popSelectedToPrompt(shell);
}

/**
 * ^X on a selected pending item: kill it outright, keeping the selection on
 * whatever slides into the freed slot so a second ^X walks down without
 * re-entering the column.
 */
export function applyPendingDrop(shell: AppShell): void {
  const bag = shellInternals(shell);
  const sel = pendingSelIndex(shell);
  if (bag === undefined || sel < 0) return;
  const id = shell.session.items[sel]?.id;
  if (id === undefined) return;
  const { state, item } = cancelItem(shell.session, id);
  if (item === null) return;
  shell.session = state;
  bag.pendingSelId =
    shell.session.items[Math.min(sel, shell.session.items.length - 1)]?.id ??
    null;
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
