/**
 * Focus tree + scroll lease types (interaction contract §5 / §6).
 * Pure data. One focus owner and one scroll lease at a time; the stack
 * records prior focus so Esc restores it.
 */

/** Known surfaces plus open string brand for list/kit consumers. */
export type FocusTarget =
  | "prompt"
  | "transcript"
  | "overlay"
  | "observe"
  | "palette"
  | (string & {});

/** One stack frame: who owns keys (`target`) and who owns wheel/page (`scrollOwner`). */
export interface FocusFrame {
  readonly id: string;
  readonly target: FocusTarget;
  readonly scrollOwner: FocusTarget;
}

/** Focus stack, bottom → top; index 0 is the shell base frame. */
export interface FocusState {
  readonly frames: readonly FocusFrame[];
}

export interface OpenOverlayOpts {
  /** Surface kind; defaults to "overlay". "palette" is the command palette. */
  readonly target?: FocusTarget;
  /** Wheel/page owner while this frame is top; defaults to `target`. */
  readonly scrollOwner?: FocusTarget;
}
