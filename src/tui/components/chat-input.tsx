import { Box, Text, useInput, usePaste } from "ink";
import { useState, useMemo, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { getCommand, listCommands } from "../commands/registry.js";
import type { CommandContext, CommandResult, SubcommandDefinition } from "../commands/registry.js";
import { useAtSuggestions, AtSuggestions } from "./at-mention/index.js";
import { color } from "../theme.js";
import {
  locatePromptCursor,
  promptContentWidth,
  promptScrollWindow,
  promptVisualLines,
} from "../prompt-layout.js";
import { composePromptActionBarModelLabel } from "./prompt-action-bar-label.js";
import {
  beginYank,
  breakKillSequence,
  emptyKillRing,
  recordKill,
  rotateYank,
  type KillRing,
} from "../kill-ring.js";

export type ChatInputProps = {
  onSubmit: (message: string) => void;
  onCommand: (result: CommandResult) => void;
  onPasteImage?: () => void;
  onPasteText?: (text: string) => boolean;
  commandContext: CommandContext;
  value: string;
  onChange: (value: string) => void;
  cwd: string;
  // Border color for the input box. The slash/@ pickers render above the box.
  borderColor?: string;
  // When false, the input ignores all keystrokes. Set while an overlay or modal
  // is capturing input so keys do not leak into the prompt underneath it.
  active?: boolean;
  // Number of messages queued for delivery at the next inference boundary.
  queuedCount?: number;
  // When true, Enter interrupts the running agent with the current input.
  // Alt+Enter queues the message as a follow-up instead.
  isProcessing?: boolean;
  // When false while processing, Enter queues via onSubmit instead of onInterrupt.
  steerOnEnter?: boolean;
  // Called when the user presses Enter while isProcessing is true.
  onInterrupt?: (message: string) => void;
  /** Recall previously sent messages (readline-style). Return true when handled. */
  onSentHistoryPrevious?: () => boolean;
  onSentHistoryNext?: () => boolean;
  onSentHistoryExitBrowse?: () => void;
  /** True while stepping through sent history (relaxes Up-at-start-only for older entries). */
  sentHistoryBrowsing?: boolean;
  // Session profile name shown before model on the action bar when set.
  profile?: string;
  // Active model name shown right-aligned on the action bar above the box.
  model?: string;
  // Reasoning effort appended after the model when set.
  effort?: string;
  // Rotating action verb shown to the left of the steer hint while processing.
  verb?: string;
  // Terminal row count, used to cap the box at 40vh and scroll internally.
  rows?: number;
  // Terminal column count, used to pre-wrap prompt text before Ink lays it out.
  columns?: number;
  attachmentSummary?: string;
  canSubmitEmpty?: boolean;
};

// Action bar above the prompt: revolving verb + interrupt/queue hint on the
// left, profile · model · effort right-aligned. Null when nothing to show.
function PromptActionBar({
  showSteerHint,
  value,
  steerOnEnter,
  queuedCount,
  verb,
  profile,
  model,
  effort,
  attachmentSummary,
}: {
  showSteerHint: boolean;
  value: string;
  steerOnEnter: boolean;
  queuedCount: number;
  verb?: string;
  profile?: string;
  model?: string;
  effort?: string;
  attachmentSummary?: string;
}): ReactNode {
  // Enter and Alt+Enter are no-ops on an empty field, so with nothing typed
  // the hint advertises the interrupt chord instead.
  const hasPromptText = value.trim().length > 0;
  const actionsText = !hasPromptText
    ? "Esc Esc interrupt"
    : !steerOnEnter
      ? "Enter queues for orchestrator"
      : "Enter steer · Alt+Enter queue";
  const steerText = queuedCount > 0 ? `${queuedCount} queued · ${actionsText}` : actionsText;
  // exactOptionalPropertyTypes: omit undefined keys rather than pass them.
  const modelText = composePromptActionBarModelLabel({
    ...(profile !== undefined ? { profile } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  });
  const showAttachments = attachmentSummary !== undefined && attachmentSummary.length > 0;
  if (!showSteerHint && modelText === undefined && !showAttachments) return null;
  return (
    <Box flexDirection="row" marginX={1} gap={1}>
      {showAttachments && (
        <Text color={color("accent")}>{attachmentSummary}</Text>
      )}
      {showSteerHint && (
        <Text dimColor>
          {verb !== undefined && verb.length > 0 ? `${verb} · ` : ""}{steerText}
        </Text>
      )}
      <Box flexGrow={1} />
      {modelText !== undefined && (
        <Text color={color("muted")} dimColor>{modelText}</Text>
      )}
    </Box>
  );
}

// The subset of Ink's Key type that applyKey needs. Keeping only what we use
// prevents coupling to Ink's full Key shape in test code.
export type InputKey = {
  leftArrow: boolean;
  rightArrow: boolean;
  backspace: boolean;
  delete: boolean;
  return: boolean;
  escape: boolean;
  upArrow: boolean;
  downArrow: boolean;
  home: boolean;
  end: boolean;
  tab: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  super: boolean;
};

export type EditState = {
  value: string;
  cursor: number;
};

const isWordSeparator = (char: string): boolean => /\s/.test(char);

function previousWordStart(value: string, cursor: number): number {
  let next = cursor;
  while (next > 0 && isWordSeparator(value[next - 1]!)) next--;
  while (next > 0 && !isWordSeparator(value[next - 1]!)) next--;
  return next;
}

function nextWordEnd(value: string, cursor: number): number {
  let next = cursor;
  while (next < value.length && isWordSeparator(value[next]!)) next++;
  while (next < value.length && !isWordSeparator(value[next]!)) next++;
  return next;
}

function lineStart(value: string, cursor: number): number {
  const previousBreak = value.lastIndexOf("\n", Math.max(0, cursor - 1));
  return previousBreak === -1 ? 0 : previousBreak + 1;
}

function lineEnd(value: string, cursor: number): number {
  const nextBreak = value.indexOf("\n", cursor);
  return nextBreak === -1 ? value.length : nextBreak;
}

// Pure function: given the current editor state and pasted text, return the
// next editor state. Mirrors the paste-handler logic without the component
// side effects (usePaste, onChange, atMention.refresh).
export function applyPaste(state: EditState, text: string): EditState {
  if (text.length === 0) return state;
  const { value, cursor } = state;
  return {
    value: value.slice(0, cursor) + text + value.slice(cursor),
    cursor: cursor + text.length,
  };
}

export function applyKey(state: EditState, input: string, key: InputKey): EditState {
  // Pure function: given the current editor state, an input character, and the
  // key flags from Ink, return the next editor state. No side effects.
  // Up/down arrows are not handled here — the caller deals with them (suggestion
  // navigation or cursor-line movement) before reaching this function.
  const { value, cursor } = state;

  if (key.meta && input === "b") {
    return { value, cursor: previousWordStart(value, cursor) };
  }

  if (key.meta && input === "f") {
    return { value, cursor: nextWordEnd(value, cursor) };
  }

  if (key.leftArrow) {
    if (key.super) return { value, cursor: lineStart(value, cursor) };
    if (key.meta || input.startsWith("\u001B")) return { value, cursor: previousWordStart(value, cursor) };
    return { value, cursor: Math.max(0, cursor - 1) };
  }

  if (key.rightArrow) {
    if (key.super) return { value, cursor: lineEnd(value, cursor) };
    if (key.meta || input.startsWith("\u001B")) return { value, cursor: nextWordEnd(value, cursor) };
    return { value, cursor: Math.min(value.length, cursor + 1) };
  }

  if (key.home) {
    return { value, cursor: lineStart(value, cursor) };
  }

  if (key.end) {
    return { value, cursor: lineEnd(value, cursor) };
  }

  if (key.backspace) {
    if (cursor === 0) return state;
    return {
      value: value.slice(0, cursor - 1) + value.slice(cursor),
      cursor: cursor - 1,
    };
  }

  if (key.delete) {
    if (cursor >= value.length) return state;
    return {
      value: value.slice(0, cursor) + value.slice(cursor + 1),
      cursor,
    };
  }

  // Shift+Enter (and Alt/Option+Enter, which some terminals send instead)
  // inserts a newline rather than submitting. Plain Enter is handled by the
  // caller as submit.
  if (key.return && (key.shift || key.meta)) {
    return {
      value: value.slice(0, cursor) + "\n" + value.slice(cursor),
      cursor: cursor + 1,
    };
  }

  // Readline control bindings: C-a/C-e jump, C-b/C-f move by one character,
  // C-d deletes the character at point (delete-char does not touch the kill
  // ring, matching readline). Kill commands (C-k, C-u, C-w) live in
  // applyKillYank because they need the kill ring. All other ctrl combos
  // are ignored.
  if (key.ctrl) {
    if (input === "a") return { value, cursor: 0 };
    if (input === "e") return { value, cursor: value.length };
    if (input === "b") return { value, cursor: Math.max(0, cursor - 1) };
    if (input === "f") return { value, cursor: Math.min(value.length, cursor + 1) };
    if (input === "d") {
      if (cursor >= value.length) return state;
      return { value: value.slice(0, cursor) + value.slice(cursor + 1), cursor };
    }
    return state;
  }

  // All remaining modifier combos and structural keys (return, escape, tab,
  // meta) are no-ops in the pure layer. The caller handles them separately.
  if (key.meta || key.return || key.escape || key.tab || key.upArrow || key.downArrow) {
    return state;
  }

  if (input.length === 0) return state;

  // Any input still starting with ESC here is an unrecognized control sequence
  // (e.g. a mouse SGR sequence that slipped past the stdin filter). It is
  // never printable text and must not be spliced into the buffer.
  if (input.charCodeAt(0) === 0x1b) return state;

  return {
    value: value.slice(0, cursor) + input + value.slice(cursor),
    cursor: cursor + input.length,
  };
}

export type KillYankResult = { state: EditState; ring: KillRing };

// Pure readline kill/yank layer, checked before applyKey. Returns null when
// the keystroke is not a kill or yank command so the caller falls through.
// Word boundaries are whitespace-based, matching the Alt+arrow movement above.
export function applyKillYank(
  state: EditState,
  ring: KillRing,
  input: string,
  key: InputKey,
): KillYankResult | null {
  const { value, cursor } = state;

  const kill = (start: number, end: number, direction: "forward" | "backward"): KillYankResult => {
    const text = value.slice(start, end);
    if (text.length === 0) return { state, ring };
    return {
      state: { value: value.slice(0, start) + value.slice(end), cursor: start },
      ring: recordKill(ring, text, direction),
    };
  };

  // M-d: kill to word end. M-backspace: kill to word start.
  if (key.meta && !key.ctrl) {
    if (input === "d") return kill(cursor, nextWordEnd(value, cursor), "forward");
    if (key.backspace) return kill(previousWordStart(value, cursor), cursor, "backward");
    if (input === "y") {
      const rotated = rotateYank(ring);
      if (rotated === null) return null;
      const { span, text } = rotated;
      // The last yank's span must still be intact (submit/clear invalidates it).
      if (span.end > value.length) return null;
      return {
        state: {
          value: value.slice(0, span.start) + text + value.slice(span.end),
          cursor: span.start + text.length,
        },
        ring: rotated.ring,
      };
    }
    return null;
  }

  if (key.ctrl && !key.meta) {
    // C-k: kill to line end; at line end, kill the newline itself.
    if (input === "k") {
      let end = lineEnd(value, cursor);
      if (end === cursor && cursor < value.length) end = cursor + 1;
      return kill(cursor, end, "forward");
    }
    // C-u: kill back to line start (unix-line-discard).
    if (input === "u") return kill(lineStart(value, cursor), cursor, "backward");
    // C-w: kill back to word start (unix-word-rubout).
    if (input === "w") return kill(previousWordStart(value, cursor), cursor, "backward");
    // C-y: yank the most recent kill at point.
    if (input === "y") {
      const yank = beginYank(ring, cursor);
      if (yank === null) return { state, ring };
      return {
        state: {
          value: value.slice(0, cursor) + yank.text + value.slice(cursor),
          cursor: cursor + yank.text.length,
        },
        ring: yank.ring,
      };
    }
    return null;
  }

  return null;
}

type SlashState =
  | { kind: "command"; prefix: string }
  | { kind: "subcommand"; parentName: string; prefix: string };

function parseSlashState(value: string): SlashState | null {
  if (!value.startsWith("/")) return null;
  const spaceIdx = value.indexOf(" ");
  if (spaceIdx === -1) return { kind: "command", prefix: value.slice(1) };
  const parentName = value.slice(1, spaceIdx);
  const cmd = getCommand(parentName);
  // Open the post-command picker for subcommands and/or a free-form argument-hint
  // (e.g. /goal, /linear-create show greyed guidance until args are typed).
  const hasSubs = cmd?.subcommands !== undefined && cmd.subcommands.length > 0;
  const hasHint = typeof cmd?.argumentHint === "string" && cmd.argumentHint.length > 0;
  if (hasSubs || hasHint) {
    return { kind: "subcommand", parentName, prefix: value.slice(spaceIdx + 1) };
  }
  return null;
}

type Suggestion =
  | { kind: "command"; name: string; description: string; argumentHint?: string }
  | { kind: "subcommand"; parentName: string; sub: SubcommandDefinition }
  | { kind: "hint"; parentName: string; hint: string };



function slashPrefix(value: string): string | null {
  if (!value.startsWith("/")) return null;
  const spaceIdx = value.indexOf(" ");
  return spaceIdx === -1 ? value.slice(1) : null;
}

export function ChatInput({
  onSubmit,
  onCommand,
  onPasteImage,
  onPasteText,
  commandContext,
  value,
  onChange,
  cwd,
  active = true,
  queuedCount = 0,
  isProcessing = false,
  steerOnEnter = true,
  onInterrupt,
  onSentHistoryPrevious,
  onSentHistoryNext,
  onSentHistoryExitBrowse,
  sentHistoryBrowsing = false,
  borderColor = color("dim"),
  profile,
  model,
  effort,
  verb,
  rows,
  columns,
  attachmentSummary,
  canSubmitEmpty = false,
}: ChatInputProps): ReactNode {
  const [cursor, setCursor] = useState(value.length);
  const [selectedIdx, setSelectedIdx] = useState(0);
  // The last value this component produced itself. Used to tell an external
  // value change (tab-completion, a programmatic set) apart from our own edit
  // echoed back through the value prop — only the former should jump the cursor
  // to the end. Without this, every keystroke snaps the cursor away from mid-line.
  const selfSetValue = useRef<string | null>(null);

  // Reset the cursor to the end only when value changes from the OUTSIDE.
  useEffect(() => {
    if (value === selfSetValue.current) return;
    setCursor(value.length);
  }, [value]);

  const atMention = useAtSuggestions(cwd);

  // Kill ring for readline kill/yank. A ref, not state: every mutation also
  // changes value or cursor, so no render depends on the ring alone.
  const killRing = useRef<KillRing>(emptyKillRing);

  const slashState = useMemo(() => parseSlashState(value), [value]);
  const suggestions = useMemo((): Suggestion[] => {
    if (slashState === null) return [];
    if (slashState.kind === "command") {
      return listCommands()
        .filter((c) => c.name.startsWith(slashState.prefix))
        .map((c) => ({
          kind: "command" as const,
          name: c.name,
          description: c.description,
          ...(c.argumentHint !== undefined ? { argumentHint: c.argumentHint } : {}),
        }));
    }
    const cmd = getCommand(slashState.parentName);
    if (cmd === undefined) return [];
    const out: Suggestion[] = [];
    // Free-form arg guidance only while the operator has not started typing.
    if (
      slashState.prefix.length === 0 &&
      typeof cmd.argumentHint === "string" &&
      cmd.argumentHint.length > 0
    ) {
      out.push({ kind: "hint", parentName: slashState.parentName, hint: cmd.argumentHint });
    }
    if (cmd.subcommands !== undefined) {
      for (const s of cmd.subcommands) {
        if (s.name.startsWith(slashState.prefix)) {
          out.push({ kind: "subcommand", parentName: slashState.parentName, sub: s });
        }
      }
    }
    return out;
  }, [slashState]);



  // Clamp selectedIdx whenever suggestions change.
  const clampedIdx = suggestions.length > 0 ? Math.min(selectedIdx, suggestions.length - 1) : 0;
  const atClampedIdx = atMention.suggestions.length > 0
    ? Math.min(atMention.selectedIdx, atMention.suggestions.length - 1)
    : 0;

  const dispatchCommand = (raw: string) => {
    const trimmed = raw.trim();
    const spaceIdx = trimmed.indexOf(" ");
    const name = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
    const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
    const def = getCommand(name);
    if (def !== undefined) {
      onCommand(def.handler(args, commandContext));
    } else {
      onCommand({ type: "message", text: `Unknown command: /${name}` });
    }
  };

  const resetField = () => {
    onChange("");
    setCursor(0);
    setSelectedIdx(0);
    atMention.clear();
  };

  // Splice a completed @path into the input at the current atState position.
  const completeAtSelection = (selected: string) => {
    if (atMention.atState === null) return;
    const { atStart, prefix } = atMention.atState;
    const trailing = selected.endsWith("/") ? "" : " ";
    // Splice replaces the @token span (from atStart to the end of the typed
    // prefix), not up to the cursor — the cursor may have been moved mid-token.
    const tokenEnd = atStart + 1 + prefix.length;
    const completed = value.slice(0, atStart) + "@" + selected + trailing + value.slice(tokenEnd);
    const newCursor = atStart + 1 + selected.length + trailing.length;
    selfSetValue.current = completed;
    onChange(completed);
    setCursor(newCursor);
    atMention.clear();
  };

  useInput((input, key) => {
    if (((key.ctrl && input === "v") || input === "\u0016") && onPasteImage !== undefined) {
      onPasteImage();
      return;
    }

    // Kill/yank dispatch runs first: the suggestion pickers below never claim
    // these chords, and readline semantics need every non-kill keystroke to
    // break kill accumulation and the M-y rotation window — including keys
    // that return early from the picker branches.
    const killYank = applyKillYank({ value, cursor }, killRing.current, input, key);
    if (killYank !== null) {
      killRing.current = killYank.ring;
      const nextState = killYank.state;
      if (nextState.value !== value) {
        onSentHistoryExitBrowse?.();
        selfSetValue.current = nextState.value;
        onChange(nextState.value);
        setCursor(nextState.cursor);
        atMention.refresh(nextState.value, nextState.cursor);
      } else if (nextState.cursor !== cursor) {
        setCursor(nextState.cursor);
        atMention.refresh(nextState.value, nextState.cursor);
      }
      return;
    }
    killRing.current = breakKillSequence(killRing.current);

    // @ picker takes priority over slash suggestions (they are mutually exclusive
    // by construction: slash state only fires when value starts with /).
    if (atMention.suggestions.length > 0) {
      if (key.upArrow) { atMention.selectUp(); return; }
      if (key.downArrow) { atMention.selectDown(); return; }
      if (key.tab || key.return) {
        const sel = atMention.suggestions[atClampedIdx];
        if (sel !== undefined) completeAtSelection(sel);
        return;
      }
      if (key.escape) {
        atMention.clear();
        return;
      }
    }

    if (suggestions.length > 0) {
      if (key.upArrow) {
        setSelectedIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIdx((i) => Math.min(suggestions.length - 1, i + 1));
        return;
      }
      if (key.tab) {
        const sel = suggestions[clampedIdx];
        if (sel !== undefined) {
          if (sel.kind === "command") {
            onChange(`/${sel.name} `);
          } else if (sel.kind === "subcommand") {
            onChange(`/${sel.parentName} ${sel.sub.name} `);
          } else {
            // Argument-hint row — leave `/cmd ` so the operator types real args.
            onChange(`/${sel.parentName} `);
          }
        }
        setSelectedIdx(0);
        return;
      }
      if (key.return) {
        const sel = suggestions[clampedIdx];
        // Hint rows are guidance only — Enter does not submit incomplete input.
        if (sel?.kind === "hint") {
          onChange(`/${sel.parentName} `);
          setSelectedIdx(0);
          return;
        }
        let completed = value;
        if (sel !== undefined) {
          if (sel.kind === "command") completed = `/${sel.name}`;
          else if (sel.kind === "subcommand") completed = `/${sel.parentName} ${sel.sub.name}`;
        }
        dispatchCommand(completed);
        resetField();
        return;

      }


      if (key.escape) {
        resetField();
        return;
      }
    }

    if (key.upArrow || key.downArrow) {
      const lineBreaks: number[] = [];
      for (let i = 0; i < value.length; i++) {
        if (value[i] === "\n") lineBreaks.push(i);
      }
      if (lineBreaks.length === 0) {
        if (
          key.upArrow
          && (sentHistoryBrowsing || cursor === 0)
          && onSentHistoryPrevious?.()
        ) return;
        if (
          key.downArrow
          && (sentHistoryBrowsing || cursor === value.length)
          && onSentHistoryNext?.()
        ) return;
      }
      if (lineBreaks.length > 0) {
        const lineStarts: number[] = [0, ...lineBreaks.map((p) => p + 1)];
        const lineEnds: number[] = [...lineBreaks, value.length];
        let li = 0;
        for (let i = 0; i < lineStarts.length; i++) {
          if (cursor >= lineStarts[i]! && cursor <= lineEnds[i]!) { li = i; break; }
        }
        const col = cursor - lineStarts[li]!;
        if (key.upArrow && li > 0) {
          const targetStart = lineStarts[li - 1]!;
          const targetEnd = lineEnds[li - 1]!;
          setCursor(Math.min(targetStart + col, targetEnd));
          return;
        }
        if (key.downArrow && li < lineStarts.length - 1) {
          const targetStart = lineStarts[li + 1]!;
          const targetEnd = lineEnds[li + 1]!;
          setCursor(Math.min(targetStart + col, targetEnd));
          return;
        }
      }
      return;
    }

    if (isProcessing && input.includes("\u001B") && (input.includes("\r") || input.includes("\n"))) {
      const trimmed = value.trim();
      if (trimmed.length > 0 || canSubmitEmpty) {
        if (trimmed.startsWith("/")) {
          dispatchCommand(trimmed);
        } else {
          onSubmit(trimmed);
        }
        resetField();
      }
      return;
    }

    if (input === "\u001B") return;

    if (key.return && !key.shift && !key.meta) {
      const trimmed = value.trim();
      if (trimmed.length > 0 || canSubmitEmpty) {
        if (trimmed.startsWith("/")) {
          dispatchCommand(trimmed);
        } else if (isProcessing && steerOnEnter && onInterrupt !== undefined) {
          onInterrupt(trimmed);
        } else {
          onSubmit(trimmed);
        }
        resetField();
      }
      return;
    }

    // Alt+Enter while processing queues the message as a follow-up rather than
    // inserting a newline, which is the usual meta+return behaviour.
    if (key.return && key.meta && !key.shift && isProcessing) {
      const trimmed = value.trim();
      if (trimmed.length > 0 || canSubmitEmpty) {
        onSubmit(trimmed);
        resetField();
      }
      return;
    }

    const next = applyKey({ value, cursor }, input, key);
    if (next.value !== value) {
      onSentHistoryExitBrowse?.();
      // Record our own edit so the value-change effect does not treat the
      // echoed prop update as external and yank the cursor to the end.
      selfSetValue.current = next.value;
      onChange(next.value);
      setCursor(next.cursor);
      atMention.refresh(next.value, next.cursor);
    } else if (next.cursor !== cursor) {
      setCursor(next.cursor);
      atMention.refresh(next.value, next.cursor);
    }
  }, { isActive: active });

  // Paste handler: receives the full pasted string as one event (bracketed paste
  // mode from the terminal). Ink's usePaste operates on a separate event channel
  // from useInput, so paste characters never trickle in one-by-one through
  // useInput — this avoids 10K+ individual re-renders on a large paste.
  usePaste((text) => {
    if (!active) return;
    killRing.current = breakKillSequence(killRing.current);
    if (onPasteText?.(text) === true) return;
    const next = applyPaste({ value, cursor }, text);
    if (next.value === value) return; // empty text — nothing changed
    selfSetValue.current = next.value;
    onChange(next.value);
    setCursor(next.cursor);
    atMention.refresh(next.value, next.cursor);
  }, { isActive: active });

  const promptWidth = promptContentWidth(columns ?? 80);
  const visualLines = promptVisualLines(value, promptWidth);
  const lines = visualLines.map((line) => line.text);
  const { cursorLine, cursorCol, cursorCharLength } = locatePromptCursor(visualLines, cursor);

  const { windowStart, windowEnd, atTopEdge, atBottomEdge } = promptScrollWindow(
    value,
    columns ?? 80,
    rows ?? 24,
    cursor,
  );

  // Slash and @ pickers are mutually exclusive: slash owns the field when value
  // starts with /, @ picker fires for any other @ token in the input.
  const showSlash = suggestions.length > 0;
  const showAt = !showSlash && atMention.suggestions.length > 0;
  // Visible whenever the agent is in flight, not just once the user has
  // typed something — interruption works either way and should be
  // discoverable immediately.
  const showSteerHint = isProcessing;

  const renderInputLines = (): ReactNode[] => {
    const out: ReactNode[] = [];
    if (atTopEdge) {
      out.push(
        <Text key="top-edge" color={color("success")}>{"  ↑"}</Text>,
      );
    }
    for (let i = windowStart; i < windowEnd; i++) {
      const line = lines[i]!;
      const prefix = i === 0 ? "> " : "  ";
      if (i !== cursorLine) {
        out.push(
          <Text key={i}>
            <Text color={color("success")}>{prefix}</Text>
            {line}
          </Text>,
        );
        continue;
      }
      const head = line.slice(0, cursorCol);
      const atChar = line.slice(cursorCol, cursorCol + cursorCharLength);
      const tail = line.slice(cursorCol + cursorCharLength);
      out.push(
        <Text key={i}>
          <Text color={color("success")}>{prefix}</Text>
          <Text>{head}</Text>
          {atChar.length > 0 ? (
            <>
              <Text backgroundColor={color("emphasis")} color={color("surface")}>{atChar}</Text>
              <Text>{tail}</Text>
            </>
          ) : (
            <Text color={color("success")}>▏</Text>
          )}
        </Text>,
      );
    }
    if (atBottomEdge) {
      out.push(
        <Text key="bottom-edge" color={color("success")}>{"  ↓"}</Text>,
      );
    }
    return out;
  };

  // When slash/@ pickers are open the input renders plainly so the
  // suggestion list sits flush above it without a competing border.
  const inputLines = renderInputLines();
  const inputBody = showSlash || showAt ? (
    <Box flexDirection="column" paddingX={1}>
      {inputLines}
    </Box>
  ) : (
    <Box marginX={1} flexDirection="column">
      <Box
        borderStyle="round"
        borderColor={borderColor}
        flexDirection="column"
        paddingX={1}
      >
        {inputLines}
      </Box>
    </Box>
  );

  return (
    <Box flexDirection="column">
      {showSlash && (
        <Box flexDirection="column" paddingX={1} paddingBottom={0}>
          {suggestions.map((s, i) => {
            const selected = i === clampedIdx;
            if (s.kind === "command") {
              return (
                <Box key={`/${s.name}`} flexDirection="row" gap={1}>
                  <Box width={22} flexShrink={0}>
                    <Text
                      color={selected ? color("accent") : color("text")}
                      bold={selected}
                      wrap="truncate-end"
                    >
                      {`/${s.name}`}
                    </Text>
                  </Box>
                  {s.argumentHint !== undefined && s.argumentHint.length > 0 && (
                    <Text color={color("muted")} dimColor wrap="truncate-end">
                      {s.argumentHint}
                    </Text>
                  )}
                  <Text color={color("muted")} wrap="truncate-end">{s.description}</Text>
                </Box>
              );
            }
            if (s.kind === "hint") {
              return (
                <Box key={`hint-${s.parentName}`} flexDirection="row" gap={1}>
                  <Box width={22} flexShrink={0}>
                    <Text color={color("muted")} dimColor wrap="truncate-end">
                      {s.hint}
                    </Text>
                  </Box>
                  <Text color={color("muted")} wrap="truncate-end">
                    args (optional pattern)
                  </Text>
                </Box>
              );
            }
            const label = `/${s.parentName} ${s.sub.name}`;
            return (
              <Box key={label} flexDirection="row" gap={1}>
                <Box width={22} flexShrink={0}>
                  <Text
                    color={selected ? color("accent") : color("text")}
                    bold={selected}
                    wrap="truncate-end"
                  >
                    {label}
                  </Text>
                </Box>
                <Text color={color("muted")} wrap="truncate-end">{s.sub.description}</Text>
              </Box>
            );
          })}


        </Box>
      )}
      {showAt && (
        <AtSuggestions suggestions={atMention.suggestions} selectedIdx={atClampedIdx} />
      )}
      <PromptActionBar
        showSteerHint={showSteerHint}
        value={value}
        steerOnEnter={steerOnEnter}
        queuedCount={queuedCount}
        {...(verb !== undefined ? { verb } : {})}
        {...(profile !== undefined ? { profile } : {})}
        {...(model !== undefined ? { model } : {})}
        {...(effort !== undefined ? { effort } : {})}
        {...(attachmentSummary !== undefined ? { attachmentSummary } : {})}
      />
      {inputBody}
    </Box>
  );
}
