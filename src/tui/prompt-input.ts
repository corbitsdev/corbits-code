/**
 * The shell's prompt input: a genuine multi-line composing area.
 *
 * OpenTUI's `InputRenderable` is hard-wired to one row, no wrapping, and
 * newlines stripped, so the prompt is built on `TextareaRenderable`. Two
 * things have to be put back on top of it:
 *
 * - **Enter sends.** The textarea's default is Enter-inserts-newline, which
 *   would swallow the shell's primary action, so the bindings below flip
 *   it: Enter submits, a newline needs an explicit chord, and Alt+Enter
 *   (follow-up) is claimed by the shell's key listener first.
 * - **`value`.** The textarea calls the buffer `plainText` and has no
 *   setter that parks the caret. The whole shell — kill ring, history
 *   recall, the `/` and `@` popups, attachments — reads and writes `value`
 *   as one logical string, so the accessor is defined here rather than
 *   rewritten at every call site.
 */

import {
  TextareaRenderable,
  type CliRenderer,
  type TextareaOptions,
} from "@opentui/core";

/** A textarea that answers to the single-line input's `value` contract. */
export type PromptInput = TextareaRenderable & { value: string };

/**
 * Enter sends the message, so a literal newline needs a chord of its own:
 * Shift+Enter or Ctrl+Enter where the terminal reports the modifier, Ctrl+J
 * (`linefeed`) everywhere else — terminals that don't negotiate the kitty
 * keyboard protocol can't report Shift+Enter at all. Alt+Enter is left
 * alone; the shell claims it for the follow-up action first.
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
 * `visualCursor.visualRow` is viewport-relative, so it reads 0 whenever the
 * caret is on the top visible row. Adding the scroll offset back gives the
 * row the operator is actually on, which decides whether Up/Down moves the
 * caret or recalls history.
 */
export function promptCaretRow(prompt: PromptInput): number {
  return prompt.visualCursor.visualRow + prompt.scrollY;
}

/**
 * Total wrapped rows the buffer occupies, however few are on screen.
 *
 * Read from the editor view's line table rather than `virtualLineCount`,
 * which counts only the rows in the viewport and stops rising once the box
 * hits its cap. The table is the same wrap the view paints and the caret is
 * measured against, so sizing and caret placement cannot drift apart.
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
