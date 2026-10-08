/**
 * The shell's prompt input: a genuine multi-line composing area.
 *
 * OpenTUI's `InputRenderable` is one row, no wrapping, newlines stripped,
 * so the prompt is built on `TextareaRenderable`. Two things are put back
 * on top:
 *
 * - **Enter sends.** The textarea defaults to Enter-inserts-newline, which
 *   would swallow the shell's primary action, so the bindings below flip
 *   it: Enter submits, a newline needs an explicit chord, and Alt+Enter
 *   (follow-up) is claimed by the shell's key listener first.
 * - **`value`.** The textarea calls the buffer `plainText` and has no
 *   setter that parks the caret. The shell — kill ring, history recall,
 *   the `/` and `@` popups, attachments — reads and writes `value` as one
 *   logical string, so the accessor lives here rather than at every call
 *   site.
 */

import {
  TextareaRenderable,
  type CliRenderer,
  type TextareaOptions,
} from "@opentui/core";

/** A textarea that answers to the single-line input's `value` contract. */
export type PromptInput = TextareaRenderable & { value: string };

/**
 * Enter sends, so a literal newline needs its own chord: Shift+Enter or
 * Ctrl+Enter where the terminal reports the modifier, Ctrl+J (`linefeed`)
 * elsewhere — terminals without the kitty keyboard protocol can't report
 * Shift+Enter. Alt+Enter is left alone; the shell claims it for follow-up.
 */
// Modifier-qualified entries lead: a first-match table would otherwise resolve
// Shift+Enter against the bare `return` submit binding and send the message.
export const PROMPT_KEY_BINDINGS = [
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
  { name: "return", ctrl: true, action: "newline" },
  { name: "kpenter", ctrl: true, action: "newline" },
  { name: "linefeed", action: "newline" },
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
] as const satisfies TextareaOptions["keyBindings"];

export type PromptInputOptions = Omit<
  TextareaOptions,
  "keyBindings" | "wrapMode" | "initialValue"
>;

export function createPromptInput(
  ctx: CliRenderer,
  options: PromptInputOptions,
): PromptInput {
  const area = new TextareaRenderable(ctx, {
    ...options,
    // Soft-wrap on words: a long line uses the rows the box already has rather
    // than scrolling sideways out of view.
    wrapMode: "word",
    keyBindings: [...PROMPT_KEY_BINDINGS],
  });

  Object.defineProperty(area, "value", {
    get: (): string => area.plainText,
    set: (next: string): void => {
      if (area.plainText === next) return;
      area.setText(next);
      area.cursorOffset = next.length;
    },
    enumerable: true,
    configurable: true,
  });

  return area as PromptInput;
}

/**
 * Where the caret sits among the buffer's wrapped rows, document-absolute.
 *
 * `visualCursor.visualRow` is viewport-relative — 0 whenever the caret is
 * on the top visible row — so the scroll offset is added back. The absolute
 * row decides whether Up/Down moves the caret or recalls history.
 */
export function promptCaretRow(prompt: PromptInput): number {
  return prompt.visualCursor.visualRow + prompt.scrollY;
}

/**
 * Total wrapped rows the buffer occupies, however few are on screen.
 *
 * Read from the editor view's line table, not `virtualLineCount`
 * (viewport-only, capped once the box fills): the table is the same wrap
 * the view paints, so sizing and caret placement cannot drift apart.
 */
export function promptRowCount(prompt: PromptInput): number {
  return Math.max(1, prompt.lineInfo.lineStartCols.length);
}

/** Up recalls history only from here; anywhere else it moves the caret up. */
export function promptCaretAtFirstRow(prompt: PromptInput): boolean {
  return promptCaretRow(prompt) <= 0;
}

/** Down recalls history only from here; anywhere else it moves the caret down. */
export function promptCaretAtLastRow(prompt: PromptInput): boolean {
  return promptCaretRow(prompt) >= promptRowCount(prompt) - 1;
}
