import { LOCKUP_WORDMARK } from "../lockup.js";
import { ESSENTIALS_SEPARATOR } from "./prompt-action-bar-label.js";

export interface SessionHeaderInput {
  /** Quiet session essentials, e.g. `profile · model · effort · mode`. */
  essentials?: string | undefined;
}

const WORDMARK = LOCKUP_WORDMARK;

/**
 * First deferred startup row after the landing clears: the wordmark leading
 * the quiet essentials line, wordmark alone when nothing applies. A re-filed
 * telemetry disclosure still lands ahead of it; later /yolo or effort
 * toggles move the prompt border label only — the header is a startup
 * snapshot.
 */
export function composeSessionHeader(input: SessionHeaderInput = {}): string {
  const essentials = input.essentials;
  if (essentials === undefined || essentials.length === 0) return WORDMARK;
  return `${WORDMARK}${ESSENTIALS_SEPARATOR}${essentials}`;
}
