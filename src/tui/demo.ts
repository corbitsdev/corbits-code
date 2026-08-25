/**
 * Interactive OpenTUI product-skin demo (real TTY only).
 * Run: `bun src/tui/demo.ts`
 *
 * Not the production CLI (`src/index.ts` → OpenTUI shell). Playground only.
 *
 * Keys:
 *   Enter=steer · Alt+Enter=follow-up · Ctrl+C=stop
 *   Alt+C=copy
 *   p=permissions · o=operator · m=model
 *   s=settings · h=help · l=plugins · e=resume · n=mentions · v=observe
 *   t/a=toggle task/agents chrome
 *   f=replay fixture · r=busy · q=quit when idle
 */
import { createCliRenderer, type KeyEvent } from "@opentui/core";

import {
  FIXTURE_BUSY_SESSION,
  attachSessionBridge,
  createRecordingPort,
} from "./runtime-bridge.js";
import type { ObserveSession } from "./residuals.js";
import { openModelPickerOverlay, openOperatorOverlay, openPermissionsOverlay } from "./overlays.js";
import { formatChromeZones } from "./chrome-state.js";
import {
  appendStreamRow,
  createAppShell,
  enterSubagentObserve,
  openHelpOverlay,
  openListOverlay,
  openMentionsOverlay,
  openSettingsOverlay,
  paintChrome,
  setChromeZones,
  setShellRunState,
} from "./shell.js";

/** Demo-only rows: never shipped, just something to look at in `s`/`l`/`e`/`n`. */
const DEMO_SETTINGS_ITEMS: readonly string[] = [
  "Permissions — revoke remembered approvals",
  "Compaction — summarize vs drop",
  "Session mode — auto / ask / plan",
  "Close settings",
];

const DEMO_PLUGINS_ITEMS: readonly string[] = [
  "plugin:linear — enabled",
  "plugin:github — needs trust",
  "Close plugins",
];

const DEMO_RESUME_ITEMS: readonly string[] = [
  "Fix permissions overflow · 2h ago · idle",
  "Wave 6 palette work · yesterday · done",
  "Close resume",
];

const DEMO_MENTION_ITEMS: readonly string[] = ["@src/tui/shell.ts", "@AGENTS.md", "Close mentions"];

function demoObserveSession(): ObserveSession {
  return {
    sessionId: "child-1",
    agentId: "explorer",
    description: "map callers of openListOverlay",
    lines: [
      { role: "system", text: "— child session explore —" },
      { role: "user", text: "find every openListOverlay caller" },
      { role: "assistant", text: "Searching src/tui…" },
      { role: "tool", text: "grep openListOverlay → 6 hits", meta: "tool.done" },
      { role: "assistant", text: "Report ready for parent." },
    ],
  };
}

if (!process.stdout.isTTY) {
  console.error("demo requires a TTY (stdout is not a terminal)");
  process.exit(1);
}

/**
 * A fleet big enough to exercise the board, including the states that matter:
 * a lane gone silent, one waiting on an approval, and enough lanes to push the
 * board past what a short terminal can show. A single-lane fixture cannot
 * demonstrate sorting, the aggregate header, or the hidden-lane disclosure —
 * which is to say it cannot demonstrate anything the board exists to do.
 */
const DEMO_FLEET = [
  ["a5", "provider catalog groundwork", 554, 390, "bash npm test"],
  ["a2", "geometry resolver split", 252, 3, "edit zones.ts"],
  ["a3", "stall watchdog thresholds", 118, 1, "edit watchdog.ts"],
  ["a4", "transcript dedupe", 12, 12, null],
  ["a6", "chrome-state formatters", 44, 2, "grep formatAgents"],
  ["a8", "keybinding audit", 161, 6, "edit keybindings"],
  ["a9", "release note sweep", 67, 67, "approve rm -rf"],
  ["a10", "telemetry catalog", 8, 8, null],
  ["a11", "docs/TUI.md rewrite", 199, 4, "write TUI.md"],
  ["a13", "pricing metadata refresh", 302, 40, "read pricing.ts"],
  ["a14", "eval harness rewrite", 123, 200, "bash bun test"],
  ["a15", "mcp view polish", 90, 5, "edit mcp-view.ts"],
].map(([agentId, description, ranSec, idleSec, tool]) => {
  const lastActivityAt = Date.now() - (idleSec as number) * 1000;
  const subject = tool as string | null;
  // Demo subjects are already human phrases ("bash npm test", "edit zones.ts").
  // Put the phrase in the preview so the board paints what the worker is doing
  // rather than a bare tool identifier (CL-5765).
  let currentToolName: string | null = null;
  let currentToolPreview: string | null = null;
  if (subject !== null) {
    currentToolPreview = subject;
    if (subject.startsWith("bash ") || subject.startsWith("approve ")) {
      currentToolName = "run_shell";
    } else if (subject.startsWith("edit ")) {
      currentToolName = "edit_file";
    } else if (subject.startsWith("write ")) {
      currentToolName = "write_file";
    } else if (subject.startsWith("read ")) {
      currentToolName = "read_file";
    } else if (subject.startsWith("grep ")) {
      currentToolName = "grep";
    } else {
      currentToolName = "run_shell";
    }
  }
  return {
    agentId: agentId as string,
    description: description as string,
    status: "running" as const,
    currentToolName,
    currentToolPreview,
    // Hybrid chrome requires the tool clock; without it a long-running tool
    // would be reclassified as stalled. Align with last activity when a tool
    // is named so demo lanes still exercise working / in_tool / stalled.
    currentToolStartedAt: subject === null ? null : lastActivityAt,
    startedAt: Date.now() - (ranSec as number) * 1000,
    lastActivityAt,
  };
});

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  targetFps: 30,
});

const shell = createAppShell(renderer, {
  title: "corbits",
  run: "idle",
});

const port = createRecordingPort();
const bridge = attachSessionBridge(shell, port);

appendStreamRow(shell, {
  role: "system",
  text: "Wave 7 — residuals + observe (s/h/l/e/n/v)",
});
appendStreamRow(shell, {
  role: "system",
  text: "p/o/m overlays · g/t/a chrome · f=fixture · r=busy · q=quit",
});

bridge.play(FIXTURE_BUSY_SESSION);

const stickyPoll = setInterval(() => {
  paintChrome(shell);
}, 120);

function quit(): void {
  clearInterval(stickyPoll);
  bridge.dispose();
  setTimeout(() => {
    shell.dispose();
    renderer.destroy();
    process.exit(0);
  }, 40);
}

renderer.keyInput.on("keypress", (key: KeyEvent) => {
  if (shell.overlayList || shell.observe) return;

  if (
    key.name === "q" &&
    !key.ctrl &&
    !key.meta &&
    shell.session.run === "idle" &&
    shell.prompt.value.length === 0
  ) {
    appendStreamRow(shell, { role: "system", text: "quit" });
    quit();
    return;
  }

  if (key.name === "f" && !key.ctrl && !key.meta && shell.prompt.value.length === 0) {
    appendStreamRow(shell, {
      role: "system",
      text: "— replaying FIXTURE_BUSY_SESSION —",
    });
    bridge.play(FIXTURE_BUSY_SESSION);
    return;
  }

  if (key.name === "r" && !key.ctrl && !key.meta && shell.prompt.value.length === 0) {
    setShellRunState(shell, "busy");
    appendStreamRow(shell, {
      role: "system",
      text: "run → BUSY (steer/follow-up active)",
    });
    return;
  }

  if (key.name === "p" && !key.ctrl && !key.meta && shell.prompt.value.length === 0) {
    openPermissionsOverlay(shell);
    return;
  }

  if (key.name === "o" && !key.ctrl && !key.meta && shell.prompt.value.length === 0) {
    openOperatorOverlay(shell);
    return;
  }

  if (key.name === "m" && !key.ctrl && !key.meta && shell.prompt.value.length === 0) {
    openModelPickerOverlay(shell);
    return;
  }

  if (key.name === "s" && !key.ctrl && !key.meta && shell.prompt.value.length === 0) {
    openSettingsOverlay(shell, { items: DEMO_SETTINGS_ITEMS });
    return;
  }

  if (key.name === "h" && !key.ctrl && !key.meta && shell.prompt.value.length === 0) {
    openHelpOverlay(shell);
    return;
  }

  if (key.name === "l" && !key.ctrl && !key.meta && shell.prompt.value.length === 0) {
    openListOverlay(shell, {
      kind: "plugins",
      title: "plugins",
      items: DEMO_PLUGINS_ITEMS,
      frameId: "overlay-plugins",
    });
    return;
  }

  if (key.name === "e" && !key.ctrl && !key.meta && shell.prompt.value.length === 0) {
    openListOverlay(shell, {
      kind: "resume",
      title: "resume session",
      items: DEMO_RESUME_ITEMS,
      frameId: "overlay-resume",
    });
    return;
  }

  if (key.name === "n" && !key.ctrl && !key.meta && shell.prompt.value.length === 0) {
    openMentionsOverlay(shell, { items: DEMO_MENTION_ITEMS });
    return;
  }

  if (key.name === "v" && !key.ctrl && !key.meta && shell.prompt.value.length === 0) {
    enterSubagentObserve(shell, demoObserveSession());
    return;
  }

  if (key.name === "t" && !key.ctrl && !key.meta && shell.prompt.value.length === 0) {
    const on = shell.layout.heights.task > 0;
    setChromeZones(shell, {
      task: on
        ? null
        : formatChromeZones({
            task: [{ title: "cutover readiness", status: "doing" }],
          }).task,
    });
    return;
  }

  if (key.name === "a" && !key.ctrl && !key.meta && shell.prompt.value.length === 0) {
    const on = shell.layout.heights.agents > 0;
    setChromeZones(shell, {
      agents: on ? null : formatChromeZones({ agents: DEMO_FLEET }).agents,
    });
    return;
  }

  if (
    key.ctrl &&
    key.name === "c" &&
    shell.session.run === "idle" &&
    shell.pendingQueue === 0 &&
    shell.prompt.value.length === 0
  ) {
    if (!shell.session.interruptFlash) {
      appendStreamRow(shell, {
        role: "system",
        text: `quit (port calls: ${port.calls.length})`,
      });
      quit();
    } else {
      shell.session = { ...shell.session, interruptFlash: false };
      paintChrome(shell);
    }
  }
});

console.log("OpenTUI Wave 7 demo — residuals s/h/l/e/n · observe v · q quit");
