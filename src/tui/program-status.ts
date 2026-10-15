/**
 * Pure OSC 7501 roll-up for one session. One root record (no lane id): a
 * terminal that speaks the protocol replaces that record on every report.
 * Lane-keyed records stay out until a real OSC 7511 terminal confirms them.
 */

import type { ProgramStatus } from "@opentui/core";

import { agentLaneIsLive } from "../subagent/agent-progress.js";
import type { ChromeAgentSession, ChromeTaskRow } from "./chrome-state.js";

const MESSAGE_MAX = 80;

export interface ProgramStatusInput {
  readonly tasks?: readonly ChromeTaskRow[] | null | undefined;
  readonly agents?: readonly ChromeAgentSession[] | null | undefined;
  /** Turn-level stall from `isStalledForDisplay`, not a per-lane clock. */
  readonly stalled: boolean;
  /** A permission or operator gate is outstanding, queued or on screen. */
  readonly gateOpen: boolean;
}

export function programStatusForChrome(
  input: ProgramStatusInput,
): ProgramStatus {
  if (input.gateOpen) {
    return {
      state: "blocked",
      app: "corbits",
      title: "corbits",
      message: "waiting on the operator",
    };
  }
  if (input.stalled) {
    return {
      state: "error",
      app: "corbits",
      title: "corbits",
      message: "stalled",
    };
  }
  const doing = input.tasks?.find((task) => task.status === "doing");
  const live = input.agents?.find((agent) => agentLaneIsLive(agent));
  if (doing !== undefined || live !== undefined) {
    const raw = doing?.title ?? live?.description ?? "working";
    return {
      state: "working",
      app: "corbits",
      title: "corbits",
      message: clip(raw.length > 0 ? raw : "working"),
    };
  }
  return {
    state: "idle",
    app: "corbits",
    title: "corbits",
    message: "idle",
  };
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MESSAGE_MAX) return flat;
  return `${flat.slice(0, MESSAGE_MAX - 3)}...`;
}
