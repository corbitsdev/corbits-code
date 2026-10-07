/**
 * The transient notice row.
 *
 * There is no permanent status strip: keys are discoverable from the landing
 * screen and the command palette, and the prompt box's border already
 * carries the model and the workspace. The row shows state that is only
 * sometimes true — a steer waiting on a tool, a copy result, pinned scroll,
 * attachments — and only while it has something to say; at defaults it
 * composes to the empty string and the shell hides it.
 *
 * MCP authorization is not a notice-row concern (a standing condition with
 * a home on the prompt box's `mcp !` marker and a surface in /mcp), and a
 * live turn contributes nothing here — the border already carries the
 * running state, so a ramp would be a second animation saying the same
 * thing.
 *
 * Pure: no renderer access, so the wording is testable without a frame.
 */

const SEP = "    ";

export const STEER_WAIT_NOTICE_MS = 3_000;

export interface NoticeState {
  /**
   * Parent tool name to surface after `STEER_WAIT_NOTICE_MS`, or null.
   * Gated by `resolveWaitingOn`; this field only controls wording.
   */
  readonly waitingOn: string | null;
  readonly interrupt: boolean;
  /** Transcript scrolled off the tail (non-default follow state). */
  readonly pinned: boolean;
  /** Transient feedback (copy result, attach failure, exit arming). */
  readonly flash: string | null;
  readonly attachments: number;
}

/**
 * Name the in-flight parent tool once a steer has been waiting long enough.
 * Silent below the delay, with no pending steer, or with no live parent tool.
 */
export function resolveWaitingOn(
  steer: number,
  inFlight: { name: string; startedAt: number } | null,
  nowMs: number,
): string | null {
  if (steer <= 0 || inFlight === null) return null;
  if (nowMs - inFlight.startedAt < STEER_WAIT_NOTICE_MS) return null;
  const name = inFlight.name.trim();
  return name.length > 0 ? name : null;
}

export function composeNoticeLine(state: NoticeState): string {
  const segments: string[] = [];
  // Pending counts earned their own surface: the column stacked on the prompt
  // box lists the items themselves, so the row no longer says "steer 2".
  if (state.waitingOn) segments.push(`waiting on ${state.waitingOn}`);
  if (state.pinned) segments.push("pinned");
  // "interrupt" is not a standing notice. Mid-run stop feedback is a system
  // row (wording without "interrupt"); empty-prompt Ctrl+C arms exit via flash.
  if (state.attachments > 0) {
    segments.push(
      `${state.attachments} image${state.attachments === 1 ? "" : "s"}`,
    );
  }
  const flash = state.flash?.trim() ?? "";
  if (flash.length > 0) segments.push(flash);
  return segments.join(SEP);
}
