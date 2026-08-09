export type {
  FocusFrame,
  FocusState,
  FocusTarget,
  OpenOverlayOpts,
  ScrollLease,
} from "./types.js";

export {
  canPopFocus,
  createFocusState,
  focusOwner,
  focusPrompt,
  focusTranscript,
  openObserve,
  openOverlay,
  popFocus,
  scrollLease,
  scrollLeaseOf,
} from "./focus-state.js";
