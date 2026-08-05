/**
 * Interactive OpenTUI app-shell demo (real TTY only).
 * Run: bun src/tui-opentui/demo.ts
 *
 * Not required for CI. Exercises createAppShell + sticky transcript + Tab focus.
 */
import {
  createCliRenderer,
  InputRenderableEvents,
  type KeyEvent,
} from "@opentui/core";

import {
  appendTranscript,
  createAppShell,
  isTranscriptFollowing,
  paintStatus,
  setPendingQueue,
} from "./shell.js";

if (!process.stdout.isTTY) {
  console.error("demo requires a TTY (stdout is not a terminal)");
  process.exit(1);
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  targetFps: 30,
});

const shell = createAppShell(renderer, {
  title: "corbits · OpenTUI shell demo",
});

appendTranscript(shell, "App shell demo — not production agent wiring.", {
  fg: "#7aa2f7",
});
appendTranscript(shell, "Tab = focus prompt/transcript · Enter = append · s = fake stream", {
  fg: "#565f89",
});
appendTranscript(shell, "Scroll up to PIN · jump to bottom (b) to FOLLOW again", {
  fg: "#565f89",
});

shell.prompt.on(InputRenderableEvents.ENTER, (value: string) => {
  const t = value.trim();
  if (!t) return;
  appendTranscript(shell, `you › ${t}`, { fg: "#bb9af7" });
  shell.prompt.value = "";
});

function fakeStream(): void {
  const t = new Date().toLocaleTimeString();
  appendTranscript(shell, `agent  ${t}  (fake stream)`, { fg: "#9ece6a" });
}

const live = setInterval(() => {
  if (shell.lineCount >= 120) {
    clearInterval(live);
    return;
  }
  if (isTranscriptFollowing(shell)) fakeStream();
}, 2500);

// Refresh FOLLOW/PINNED label while operator scrolls.
const stickyPoll = setInterval(() => {
  paintStatus(shell);
}, 100);

renderer.keyInput.on("keypress", (key: KeyEvent) => {
  if (key.ctrl && key.name === "c") {
    appendTranscript(shell, "quit", { fg: "#f7768e" });
    clearInterval(live);
    clearInterval(stickyPoll);
    setTimeout(() => {
      shell.dispose();
      renderer.destroy();
      process.exit(0);
    }, 40);
    return;
  }

  if (key.name === "s" && !key.ctrl && !key.meta && shell.prompt.value.length === 0) {
    fakeStream();
    return;
  }

  if (
    (key.name === "b" || key.name === "end") &&
    !key.ctrl &&
    !key.meta &&
    shell.prompt.value.length === 0
  ) {
    shell.transcript.scrollTo(Number.MAX_SAFE_INTEGER);
    paintStatus(shell);
    return;
  }

  if (key.name === "q" && !key.ctrl && !key.meta && shell.prompt.value.length === 0) {
    setPendingQueue(shell, shell.pendingQueue + 1);
  }
});
