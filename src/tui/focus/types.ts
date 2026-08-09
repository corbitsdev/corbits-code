/**
 * Focus tree + scroll lease types (interaction contract §5 / §6).
 *
 * Pure data — no paint, no OpenTUI/Ink. One focus owner and one scroll lease
 * at a time; the stack records prior focus so Esc restores it.
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
export type FocusFrame = {
  readonly id: string;
  readonly target: FocusTarget;
  readonly scrollOwner: FocusTarget;
};

/**
 * Focus stack, bottom → top.
 * Index 0 is always the shell base frame. Overlays and observe push above it.
 */
export type FocusState = {
  readonly frames: readonly FocusFrame[];
};

/** Current scroll lease derived from the top frame. */
export type ScrollLease = {
  readonly owner: FocusTarget | null;
};

export type OpenOverlayOpts = {
  /**
   * Surface kind. Defaults to `"overlay"`.
   * Use `"palette"` for the command palette (still an overlay-priority slot).
   */
  readonly target?: FocusTarget;
  /**
   * Who receives wheel/page while this frame is top.
   * Defaults to `target` (list/body owns scroll).
   */
  readonly scrollOwner?: FocusTarget;
};
