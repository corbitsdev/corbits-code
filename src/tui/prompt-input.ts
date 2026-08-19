/**
 * The shell's prompt input: a genuine multi-line composing area.
 *
 * OpenTUI's `InputRenderable` is hard-wired to one row, no wrapping, and
 * newlines stripped, so the prompt is built on `TextareaRenderable` instead —
 * the same widget `InputRenderable` derives from, minus those constraints.
 * Two things have to be put back on top of it:
 *
 * - **Enter sends.** The textarea's default is Enter-inserts-newline, which
 *   would swallow the shell's primary action. The bindings below flip it: Enter
 *   submits and a newline needs an explicit chord. Alt+Enter (follow-up) is
 *   claimed by the shell's key listener before the widget ever sees it.
 * - **`value`.** `InputRenderable` exposes the buffer as `value`; the textarea
 *   calls it `plainText` and has no setter that also parks the caret. The whole
 *   shell — kill ring, history recall, the `/` and `@` popups, attachments —
 *   reads and writes `value` as one logical string with global offsets, which
 *   stays true for a multi-line buffer, so the accessor is defined here rather
 *   than rewritten at every call site.
 */

import {
  TextareaRenderable,
  type CliRenderer,
  type TextareaOptions,
} from "@opentui/core"

/** A textarea that answers to the single-line input's `value` contract. */
export type PromptInput = TextareaRenderable & { value: string }

/**
 * Enter sends the message, so a literal newline needs a chord of its own.
 * Shift+Enter or Ctrl+Enter where the terminal reports the modifier, Ctrl+J
 * (`linefeed`) everywhere else — terminals that don't negotiate the kitty
 * keyboard protocol can't report Shift+Enter at all, so the fallback chords
 * are what make this work in practice. Alt+Enter is left alone; the shell
 * claims it for the follow-up action before the widget ever sees it.
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
] as const satisfies TextareaOptions["keyBindings"]

export type PromptInputOptions = Omit<
  TextareaOptions,
  "keyBindings" | "wrapMode" | "initialValue"
>

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
  })

  Object.defineProperty(area, "value", {
    get: (): string => area.plainText,
    set: (next: string): void => {
      if (area.plainText === next) return
      area.setText(next)
      area.cursorOffset = next.length
    },
    enumerable: true,
    configurable: true,
  })

  return area as PromptInput
}

/**
 * Where the caret sits among the buffer's wrapped rows, document-absolute.
 *
 * `visualCursor.visualRow` is viewport-relative, so it reads 0 whenever the
 * caret is on the top visible row — including halfway down a scrolled buffer.
 * Adding the scroll offset back gives the row the operator is actually on,
 * which is what decides whether Up/Down moves the caret or recalls history.
 */
export function promptCaretRow(prompt: PromptInput): number {
  return prompt.visualCursor.visualRow + prompt.scrollY
}

/**
 * Total wrapped rows the buffer occupies, however few of them are on screen.
 *
 * Read from the editor view's line table rather than `virtualLineCount`, which
 * counts the rows currently in the viewport and so stops rising the moment the
 * box hits its cap — the box would then never know it had more to show. The
 * table is the same wrap the view paints and the same one the caret is measured
 * against, so sizing and caret placement cannot drift apart.
 */
export function promptRowCount(prompt: PromptInput): number {
  return Math.max(1, prompt.lineInfo.lineStartCols.length)
}

/** Up recalls history only from here; anywhere else it moves the caret up. */
export function promptCaretAtFirstRow(prompt: PromptInput): boolean {
  return promptCaretRow(prompt) <= 0
}

/** Down recalls history only from here; anywhere else it moves the caret down. */
export function promptCaretAtLastRow(prompt: PromptInput): boolean {
  return promptCaretRow(prompt) >= promptRowCount(prompt) - 1
}
