/**
 * Subagent observe surface insertion and teardown.
 */
import { focusOwner, openObserve, popFocus } from "../focus/index.js";
import { type ObserveSession } from "../residuals.js";

import { type AppShell, getPaletteOnObserveRequest } from "./internals.js";
import {
  appendObserveStreamRow,
  appendStreamRow,
  applyFocus,
  repaintTranscriptWindow,
  setChromeZones,
} from "./chrome.js";

/**
 * Enter a child subagent session view.
 * Host passes live rows + agent label (`ObserveSession`); fixture via
 * `makeObserveFixture()` is only for demo/tests. Esc restores parent lease.
 */
export function enterSubagentObserve(shell: AppShell, session: ObserveSession): void {
  if (shell.observe) {
    leaveSubagentObserve(shell);
  }

  const seedLines = session.lines.slice();
  shell.parentStreamLog = shell.streamLog.slice();
  shell.parentStreamLogBase = shell.streamLogBase;
  shell.observe = {
    sessionId: session.sessionId,
    agentId: session.agentId,
    description: session.description,
    lines: seedLines.slice(),
  };

  // A fresh log for the child view; its own indices start at zero regardless
  // of how far the parent's retention cap has already trimmed.
  shell.streamLog = seedLines;
  shell.streamLogBase = 0;
  shell.lineCount = shell.streamLog.length;
  repaintTranscriptWindow(shell);

  shell.focus = openObserve(shell.focus, `observe-${session.sessionId}`);
  setChromeZones(shell, {
    agents: [
      {
        label: `observe: ${session.agentId} — ${session.description}`,
        tail: "",
        stalled: false,
      },
    ],
  });
  // Child chrome toast — must not route to parent snapshot.
  appendObserveStreamRow(shell, {
    role: "system",
    text: `Viewing ${session.agentId}: ${session.description}`,
    meta: "observe",
  });
  applyFocus(shell);
}

/** Leave observe; restore parent stream + focus lease. */
export function leaveSubagentObserve(shell: AppShell): void {
  if (!shell.observe) return;

  const agentId = shell.observe.agentId;
  shell.observe = null;

  if (shell.parentStreamLog) {
    shell.streamLog = shell.parentStreamLog;
    shell.streamLogBase = shell.parentStreamLogBase ?? 0;
    shell.parentStreamLog = null;
    shell.parentStreamLogBase = null;
  }
  shell.lineCount = shell.streamLog.length;
  repaintTranscriptWindow(shell);

  let guard = 4;
  while (guard-- > 0 && focusOwner(shell.focus) === "observe") {
    shell.focus = popFocus(shell.focus);
  }
  // Drop any observe frames that weren't top.
  const frames = shell.focus.frames.filter((f) => f.target !== "observe");
  if (frames.length > 0) shell.focus = { frames };

  setChromeZones(shell, { agents: null });
  appendStreamRow(shell, {
    role: "system",
    text: `left observe (${agentId})`,
    meta: "observe",
  });
  applyFocus(shell);
}

/**
 * Alt+O: observe a live subagent (its only entry point now that the palette
 * is gone — the palette's "observe" action used to call this same
 * `onObserveRequest` host hook). An honest "nothing to observe" flash rather
 * than doing nothing when there is no live session, so the chord is
 * discoverable as working even when it currently has nothing to show.
 */
export function observeActiveSubagent(shell: AppShell): void {
  const onObserveRequest = getPaletteOnObserveRequest(shell);
  const session = onObserveRequest ? onObserveRequest() : null;
  if (session) {
    enterSubagentObserve(shell, session);
    return;
  }
  appendStreamRow(shell, {
    role: "system",
    text: "no subagent session to observe",
    meta: "observe",
  });
}
