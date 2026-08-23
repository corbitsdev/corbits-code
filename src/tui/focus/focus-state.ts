/**
 * Focus tree + scroll lease state machine (interaction contract §5 / §6).
 *
 * Functional immutable updates. No classes, no paint.
 *
 * Priority (high → low): overlay (incl. palette) > entered observe > shell.
 * Esc pops exactly one level and restores the recorded prior frame's focus
 * and scroll lease.
 *
 * Opening palette while an overlay is already open: **stack** (not replace).
 * Single Esc path — one pop closes palette, next pop closes the prior overlay.
 */

import type { FocusFrame, FocusState, FocusTarget, OpenOverlayOpts, ScrollLease } from "./types.js";

const SHELL_ID = "shell";

const shellFrame = (
  target: FocusTarget = "prompt",
  scrollOwner: FocusTarget = "transcript",
): FocusFrame => ({
  id: SHELL_ID,
  target,
  scrollOwner,
});

/** Initial shell: prompt owns typing; transcript holds the scroll lease. */
export function createFocusState(): FocusState {
  return { frames: [shellFrame()] };
}

function top(state: FocusState): FocusFrame {
  const frame = state.frames[state.frames.length - 1];
  if (frame === undefined) {
    // Invariant: stack is never empty after createFocusState.
    return shellFrame();
  }
  return frame;
}

function isShellOnly(state: FocusState): boolean {
  return state.frames.length === 1 && top(state).id === SHELL_ID;
}

/** Current focus owner (receives non-reserved keys). */
export function focusOwner(state: FocusState): FocusTarget {
  return top(state).target;
}

/** Current scroll lease owner (wheel + page/line scroll). */
export function scrollLease(state: FocusState): FocusTarget | null {
  return top(state).scrollOwner;
}

/** Scroll lease as a struct for callers that prefer an object. */
export function scrollLeaseOf(state: FocusState): ScrollLease {
  return { owner: scrollLease(state) };
}

/**
 * Push an overlay (permission, settings, help, …) or palette.
 * Lease moves to the overlay list/body. Stacks above whatever is current —
 * including an existing overlay or observe view.
 */
export function openOverlay(state: FocusState, id: string, opts?: OpenOverlayOpts): FocusState {
  const target = opts?.target ?? "overlay";
  const scrollOwner = opts?.scrollOwner ?? target;
  const frame: FocusFrame = { id, target, scrollOwner };
  return { frames: [...state.frames, frame] };
}

/**
 * Enter subagent observe. Child transcript takes the scroll lease.
 * Parent prompt does not receive typing while observe is top.
 * If overlays sit above shell, observe is inserted above shell and below
 * any overlays so overlay priority is preserved.
 */
export function openObserve(state: FocusState, id: string): FocusState {
  const observeFrame: FocusFrame = {
    id,
    target: "observe",
    scrollOwner: "observe",
  };

  // Replace an existing observe frame (one entered-subagent view).
  const withoutObserve = state.frames.filter((f) => f.target !== "observe");

  // Insert above shell (index 0), below any overlays already stacked.
  const shell = withoutObserve[0] ?? shellFrame();
  const above = withoutObserve.slice(1);
  return { frames: [shell, observeFrame, ...above] };
}

/**
 * Esc semantics: pop exactly one level.
 * - Overlay / palette → restore recorded prior (may be observe or shell).
 * - Observe → shell with prompt focused and transcript lease.
 * - Shell with transcript "browse" → prompt + transcript lease.
 * - Shell at prompt → unchanged (no silent dead key for dismissible UI;
 *   clear-prompt policy lives outside this machine).
 */
export function popFocus(state: FocusState): FocusState {
  if (state.frames.length > 1) {
    const next = state.frames.slice(0, -1);
    // Left observe (or last stacked surface): shell is sole frame → prompt + transcript.
    if (next.length === 1 && next[0]!.id === SHELL_ID) {
      return { frames: [shellFrame("prompt", "transcript")] };
    }
    // Popped overlay/palette above observe (or another overlay): restore as recorded.
    return { frames: next };
  }

  // Shell only: Esc from transcript browse restores prompt.
  const base = top(state);
  if (base.target === "transcript") {
    return { frames: [shellFrame("prompt", "transcript")] };
  }
  return state;
}

/**
 * Shell-only: prompt owns typing; default scroll lease is transcript.
 * No-op when an overlay or observe frame is on the stack.
 */
export function focusPrompt(state: FocusState): FocusState {
  if (!isShellOnly(state)) return state;
  return { frames: [shellFrame("prompt", "transcript")] };
}

/**
 * Shell-only: operator browsing the main transcript (scroll lease on transcript).
 * No-op when an overlay or observe frame is on the stack.
 */
export function focusTranscript(state: FocusState): FocusState {
  if (!isShellOnly(state)) return state;
  return { frames: [shellFrame("transcript", "transcript")] };
}

/** True when the stack has a dismissible frame (overlay, palette, or observe). */
export function canPopFocus(state: FocusState): boolean {
  if (state.frames.length > 1) return true;
  return top(state).target === "transcript";
}
