/**
 * Interactive OpenTUI product-skin demo (real TTY only).
 * Run: bun src/tui-opentui/demo.ts
 *
 * Not required for CI. Exercises stream rows, queue/steer/interrupt, inset overlay.
 * Not wired to production CLI — Ink remains production.
 */
import { createCliRenderer, type KeyEvent } from "@opentui/core"

import {
  appendStreamRow,
  createAppShell,
  isTranscriptFollowing,
  openInsetOverlay,
  paintStatus,
  setShellRunState,
} from "./shell.js"

if (!process.stdout.isTTY) {
  console.error("demo requires a TTY (stdout is not a terminal)")
  process.exit(1)
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  targetFps: 30,
})

const shell = createAppShell(renderer, {
  title: "corbits",
  run: "busy",
})

appendStreamRow(shell, {
  role: "system",
  text: "Wave 3 product skin — fake session, no agent loop",
})
appendStreamRow(shell, {
  role: "user",
  text: "list files in the project root",
})
appendStreamRow(shell, {
  role: "assistant",
  text: "I'll list the directory with bash.",
})
appendStreamRow(shell, {
  role: "tool",
  text: "ls -la",
  meta: "bash",
})
appendStreamRow(shell, {
  role: "system",
  text: "Enter=queue · Alt+Enter=steer · Ctrl+C=stop · Ctrl+O=permission · Tab=focus · q=quit when idle",
})

// Fake agent stream while following + busy.
let tick = 0
const live = setInterval(() => {
  if (shell.session.run !== "busy") return
  if (!isTranscriptFollowing(shell)) return
  tick += 1
  if (tick % 3 === 0) {
    appendStreamRow(shell, {
      role: "tool",
      text: `heartbeat ${tick}`,
      meta: "tick",
    })
  } else {
    appendStreamRow(shell, {
      role: "assistant",
      text: `still working… step ${tick}`,
    })
  }
  if (shell.lineCount >= 80) {
    clearInterval(live)
  }
}, 2200)

const stickyPoll = setInterval(() => {
  paintStatus(shell)
}, 120)

function quit(): void {
  clearInterval(live)
  clearInterval(stickyPoll)
  setTimeout(() => {
    shell.dispose()
    renderer.destroy()
    process.exit(0)
  }, 40)
}

// Extra demo keys (product keys already wired by createAppShell).
renderer.keyInput.on("keypress", (key: KeyEvent) => {
  // Quit when idle + empty prompt + q
  if (
    key.name === "q" &&
    !key.ctrl &&
    !key.meta &&
    shell.session.run === "idle" &&
    shell.prompt.value.length === 0 &&
    !shell.overlayList
  ) {
    appendStreamRow(shell, { role: "system", text: "quit" })
    quit()
    return
  }

  // r = re-busy for more queue demos
  if (
    key.name === "r" &&
    !key.ctrl &&
    !key.meta &&
    shell.prompt.value.length === 0 &&
    !shell.overlayList
  ) {
    setShellRunState(shell, "busy")
    appendStreamRow(shell, {
      role: "system",
      text: "run → BUSY (queue/steer active again)",
    })
    return
  }

  // o without ctrl as shortcut to overlay when prompt empty
  if (
    key.name === "o" &&
    !key.ctrl &&
    !key.meta &&
    shell.prompt.value.length === 0 &&
    !shell.overlayList
  ) {
    openInsetOverlay(shell)
    return
  }

  // After interrupt, second Ctrl+C with idle empty prompt quits demo
  if (
    key.ctrl &&
    key.name === "c" &&
    shell.session.run === "idle" &&
    shell.pendingQueue === 0 &&
    shell.prompt.value.length === 0 &&
    !shell.overlayList
  ) {
    // First Ctrl+C already handled by shell as interrupt; second as quit
    // Use a short delay check — shell sets idle on interrupt.
    // Detect flash cleared: if no flash and idle, quit.
    if (!shell.session.interruptFlash) {
      appendStreamRow(shell, { role: "system", text: "quit" })
      quit()
    } else {
      // clear flash so next Ctrl+C quits
      shell.session = { ...shell.session, interruptFlash: false }
      paintStatus(shell)
    }
  }
})
