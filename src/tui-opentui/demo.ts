/**
 * Interactive OpenTUI product-skin demo (real TTY only).
 * Run: bun src/tui-opentui/demo.ts
 *
 * Wave 6: palette + long-log + chrome + copy on shared kit.
 * Not production CLI. Ink remains production.
 *
 * Keys:
 *   Enter=queue · Alt+Enter=steer · Ctrl+C=stop
 *   Ctrl+O=palette · Alt+C=copy
 *   p=permissions · o=operator · m=model picker
 *   g/t/a=toggle goal/task/agents chrome
 *   f=replay fixture · r=busy · q=quit when idle
 */
import { createCliRenderer, type KeyEvent } from "@opentui/core"

import {
  FIXTURE_BUSY_SESSION,
  attachSessionBridge,
  createRecordingPort,
} from "./runtime-bridge.js"
import {
  openModelPickerOverlay,
  openOperatorOverlay,
  openPermissionsOverlay,
} from "./overlays.js"
import {
  appendStreamRow,
  createAppShell,
  paintStatus,
  setChromeZones,
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
  text: "Wave 6 — palette · long-log · chrome · copy (Ctrl+O / Alt+C)",
})
appendStreamRow(shell, {
  role: "system",
  text: "p=permissions · o=operator · m=model · g/t/a=chrome · f=fixture · r=busy · q=quit",
})

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

// Demo-only chords (shell owns Ctrl+O palette, Alt+C copy, queue/steer/interrupt).
renderer.keyInput.on("keypress", (key: KeyEvent) => {
  if (shell.overlayList) return

  if (
    key.name === "q" &&
    !key.ctrl &&
    !key.meta &&
    shell.session.run === "idle" &&
    shell.prompt.value.length === 0
  ) {
    appendStreamRow(shell, { role: "system", text: "quit" })
    quit()
    return
  }

  if (
    key.name === "f" &&
    !key.ctrl &&
    !key.meta &&
    shell.prompt.value.length === 0
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
    shell.prompt.value.length === 0
  ) {
    setShellRunState(shell, "busy")
    appendStreamRow(shell, {
      role: "system",
      text: "run → BUSY (queue/steer active)",
    })
    return
  }

  if (
    key.name === "p" &&
    !key.ctrl &&
    !key.meta &&
    shell.prompt.value.length === 0
  ) {
    openPermissionsOverlay(shell)
    return
  }

  if (
    key.name === "o" &&
    !key.ctrl &&
    !key.meta &&
    shell.prompt.value.length === 0
  ) {
    openOperatorOverlay(shell)
    return
  }

  if (
    key.name === "m" &&
    !key.ctrl &&
    !key.meta &&
    shell.prompt.value.length === 0
  ) {
    openModelPickerOverlay(shell)
    return
  }

  if (
    key.name === "g" &&
    !key.ctrl &&
    !key.meta &&
    shell.prompt.value.length === 0
  ) {
    const on = shell.layout.heights.goal > 0
    setChromeZones(shell, {
      goal: on ? null : "goal: Wave 6 palette + long-log + chrome",
    })
    return
  }

  if (
    key.name === "t" &&
    !key.ctrl &&
    !key.meta &&
    shell.prompt.value.length === 0
  ) {
    const on = shell.layout.heights.task > 0
    setChromeZones(shell, {
      task: on ? null : "task: implement Wave 6 acceptance",
    })
    return
  }

  if (
    key.name === "a" &&
    !key.ctrl &&
    !key.meta &&
    shell.prompt.value.length === 0
  ) {
    const on = shell.layout.heights.agents > 0
    setChromeZones(shell, {
      agents: on ? null : "agents: 0 running",
    })
    return
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
      })
      quit()
    } else {
      shell.session = { ...shell.session, interruptFlash: false }
      paintStatus(shell)
    }
  }
})

console.log(
  "OpenTUI Wave 6 demo — Ctrl+O palette · Alt+C copy · p/o/m overlays · g/t/a chrome · q quit",
)
