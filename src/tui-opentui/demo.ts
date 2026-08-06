/**
 * Interactive OpenTUI product-skin demo (real TTY only).
 * Run: bun src/tui-opentui/demo.ts
 *
 * Wave 7: residual surfaces + observe on shared kit.
 * Not production CLI. Ink remains production.
 *
 * Keys:
 *   Enter=queue · Alt+Enter=steer · Ctrl+C=stop
 *   Ctrl+O=palette · Alt+C=copy
 *   p=permissions · o=operator · m=model
 *   s=settings · h=help · l=plugins · e=resume · n=mentions · v=observe
 *   g/t/a=toggle goal/task/agents chrome
 *   f=replay fixture · r=busy · q=quit when idle
 */
import { createCliRenderer, type KeyEvent } from "@opentui/core"

import {
  FIXTURE_BUSY_SESSION,
  attachSessionBridge,
  createRecordingPort,
} from "./runtime-bridge.js"
import { makeObserveFixture } from "./residuals.js"
import {
  openModelPickerOverlay,
  openOperatorOverlay,
  openPermissionsOverlay,
} from "./overlays.js"
import { formatChromeZones } from "./chrome-state.js"
import {
  appendStreamRow,
  createAppShell,
  enterSubagentObserve,
  openHelpOverlay,
  openMentionsOverlay,
  openPluginsOverlay,
  openResumeOverlay,
  openSettingsOverlay,
  paintChrome,
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
  text: "Wave 7 — residuals + observe (s/h/l/e/n/v · Ctrl+O palette)",
})
appendStreamRow(shell, {
  role: "system",
  text: "p/o/m overlays · g/t/a chrome · f=fixture · r=busy · q=quit",
})

bridge.play(FIXTURE_BUSY_SESSION)

const stickyPoll = setInterval(() => {
  paintChrome(shell)
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
  if (shell.overlayList || shell.observe) return

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
    key.name === "s" &&
    !key.ctrl &&
    !key.meta &&
    shell.prompt.value.length === 0
  ) {
    openSettingsOverlay(shell)
    return
  }

  if (
    key.name === "h" &&
    !key.ctrl &&
    !key.meta &&
    shell.prompt.value.length === 0
  ) {
    openHelpOverlay(shell)
    return
  }

  if (
    key.name === "l" &&
    !key.ctrl &&
    !key.meta &&
    shell.prompt.value.length === 0
  ) {
    openPluginsOverlay(shell)
    return
  }

  if (
    key.name === "e" &&
    !key.ctrl &&
    !key.meta &&
    shell.prompt.value.length === 0
  ) {
    openResumeOverlay(shell)
    return
  }

  if (
    key.name === "n" &&
    !key.ctrl &&
    !key.meta &&
    shell.prompt.value.length === 0
  ) {
    openMentionsOverlay(shell)
    return
  }

  if (
    key.name === "v" &&
    !key.ctrl &&
    !key.meta &&
    shell.prompt.value.length === 0
  ) {
    enterSubagentObserve(shell, makeObserveFixture())
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
      goal: on
        ? null
        : formatChromeZones({
            goal: {
              title: "Wave 7 residual surfaces + observe",
              phase: "implementing",
              status: "active",
            },
          }).goal,
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
      task: on
        ? null
        : formatChromeZones({ task: "cutover readiness" }).task,
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
    // Empty list → null (hide). Demo forces a zero-live summary string when on.
    setChromeZones(shell, {
      agents: on
        ? null
        : formatChromeZones({
            agents: [],
          }).agents ?? "agents: 0 live",
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
      paintChrome(shell)
    }
  }
})

console.log(
  "OpenTUI Wave 7 demo — residuals s/h/l/e/n · observe v · Ctrl+O palette · q quit",
)
