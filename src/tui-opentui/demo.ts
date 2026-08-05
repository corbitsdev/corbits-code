/**
 * Interactive OpenTUI product-skin demo (real TTY only).
 * Run: bun src/tui-opentui/demo.ts
 *
 * Wave 4: fixture-driven runtime bridge (recording port). Not production CLI.
 * Ink remains production.
 *
 * Keys: Enter=queue · Alt+Enter=steer · Ctrl+C=stop · Ctrl+O=overlay
 *       f=replay fixture · r=busy · q=quit when idle
 */
import { createCliRenderer, type KeyEvent } from "@opentui/core"

import {
  FIXTURE_BUSY_SESSION,
  attachSessionBridge,
  createRecordingPort,
} from "./runtime-bridge.js"
import {
  appendStreamRow,
  createAppShell,
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
  run: "idle",
})

const port = createRecordingPort()
const bridge = attachSessionBridge(shell, port)

appendStreamRow(shell, {
  role: "system",
  text: "Wave 4 runtime bridge — fixture + recording SessionPort",
})
appendStreamRow(shell, {
  role: "system",
  text: "f=replay fixture · Enter=queue · Alt+Enter=steer · Ctrl+C=stop · Ctrl+O=overlay · r=busy · q=quit",
})

// Seed a short fixture so the transcript is not empty.
bridge.play(FIXTURE_BUSY_SESSION)

const stickyPoll = setInterval(() => {
  paintStatus(shell)
}, 120)

function quit(): void {
  clearInterval(stickyPoll)
  bridge.dispose()
  setTimeout(() => {
    shell.dispose()
    renderer.destroy()
    process.exit(0)
  }, 40)
}

renderer.keyInput.on("keypress", (key: KeyEvent) => {
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

  // f = replay fixture session through the bridge
  if (
    key.name === "f" &&
    !key.ctrl &&
    !key.meta &&
    shell.prompt.value.length === 0 &&
    !shell.overlayList
  ) {
    appendStreamRow(shell, {
      role: "system",
      text: "— replaying FIXTURE_BUSY_SESSION —",
    })
    bridge.play(FIXTURE_BUSY_SESSION)
    return
  }

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
      text: "run → BUSY (queue/steer active; port records enqueue)",
    })
    return
  }

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

  if (
    key.ctrl &&
    key.name === "c" &&
    shell.session.run === "idle" &&
    shell.pendingQueue === 0 &&
    shell.prompt.value.length === 0 &&
    !shell.overlayList
  ) {
    if (!shell.session.interruptFlash) {
      appendStreamRow(shell, {
        role: "system",
        text: `quit (port calls: ${port.calls.length})`,
      })
      quit()
    } else {
      shell.session = { ...shell.session, interruptFlash: false }
      paintStatus(shell)
    }
  }
})
