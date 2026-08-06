/**
 * Pure gate-wire unit tests — no renderer.
 */
import { EventEmitter } from "node:events"
import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "../permission/types.js"
import { withTestRenderer } from "./harness.js"
import { OVERLAY_MAX_FRACTION } from "./geometry/index.js"
import {
  acceptOverlaySelection,
  createAppShell,
  toggleOverlayExpand,
  type AppShell,
} from "./shell.js"
import {
  approvalOutcomeFromSelection,
  operatorCancelResult,
  operatorChoicesFromOptions,
  operatorCustomResult,
  operatorResultFromSelection,
  PERMISSION_DENY_ID,
  PERMISSION_ONCE_ID,
  permissionBodyFromRequest,
  permissionChoicesFromRequest,
  wireGates,
} from "./gate-wire.js"

const baseRequest = (
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest => ({
  tool: "run_shell",
  action: "Run shell command",
  subject: "bun test",
  scopes: [],
  ...overrides,
})

describe("permissionChoicesFromRequest", () => {
  test("always includes reject + accept once", () => {
    const choices = permissionChoicesFromRequest(baseRequest())
    expect(choices.items).toEqual(["Reject", "Accept once"])
    expect(choices.itemIds).toEqual([PERMISSION_DENY_ID, PERMISSION_ONCE_ID])
    expect(choices.outcomes).toEqual([{ allow: false }, { allow: true }])
  })

  test("appends scopes with optional hint; persist only when pattern set", () => {
    const scopeWithPattern = {
      id: "session-git",
      label: "Allow git *",
      pattern: "git *",
      hint: "family",
      grant: "session" as const,
    }
    const onceScope = {
      id: "once-extra",
      label: "Allow this path",
      pattern: null,
    }
    const choices = permissionChoicesFromRequest(
      baseRequest({
        scopes: [scopeWithPattern, onceScope],
      }),
    )
    expect(choices.items).toEqual([
      "Reject",
      "Accept once",
      "Allow git * (family)",
      "Allow this path",
    ])
    expect(choices.itemIds).toEqual([
      PERMISSION_DENY_ID,
      PERMISSION_ONCE_ID,
      "session-git",
      "once-extra",
    ])
    expect(choices.outcomes[2]).toEqual({
      allow: true,
      persist: scopeWithPattern,
    })
    expect(choices.outcomes[3]).toEqual({ allow: true })
  })
})

describe("approvalOutcomeFromSelection", () => {
  test("index maps to parallel outcomes; OOB denies", () => {
    const choices = permissionChoicesFromRequest(
      baseRequest({
        scopes: [
          {
            id: "proj",
            label: "Allow always",
            pattern: "bun test",
            grant: "project",
          },
        ],
      }),
    )
    expect(approvalOutcomeFromSelection(choices, { index: 0 })).toEqual({
      allow: false,
    })
    expect(approvalOutcomeFromSelection(choices, { index: 1 })).toEqual({
      allow: true,
    })
    expect(approvalOutcomeFromSelection(choices, { index: 2 }).allow).toBe(
      true,
    )
    expect(
      approvalOutcomeFromSelection(choices, { index: 2 }).persist?.id,
    ).toBe("proj")
    expect(approvalOutcomeFromSelection(choices, { index: 99 })).toEqual({
      allow: false,
    })
  })

  test("id preferred over index when present", () => {
    const choices = permissionChoicesFromRequest(
      baseRequest({
        scopes: [
          { id: "a", label: "A", pattern: "a*" },
          { id: "b", label: "B", pattern: "b*" },
        ],
      }),
    )
    const byId = approvalOutcomeFromSelection(choices, {
      index: 0,
      id: "b",
    })
    expect(byId.allow).toBe(true)
    expect(byId.persist?.id).toBe("b")
  })

  test("unknown id falls back to index", () => {
    const choices = permissionChoicesFromRequest(baseRequest())
    expect(
      approvalOutcomeFromSelection(choices, {
        index: 1,
        id: "missing",
      }),
    ).toEqual({ allow: true })
  })
})

describe("permissionBodyFromRequest", () => {
  test("joins tool/action/subject and optional agent/notice", () => {
    expect(permissionBodyFromRequest(baseRequest())).toBe(
      "run_shell\nRun shell command\nbun test",
    )
    expect(
      permissionBodyFromRequest(
        baseRequest({
          agentLabel: "explore",
          notice: "mega-chain",
        }),
      ),
    ).toBe(
      "run_shell\nRun shell command\nbun test\nagent: explore\nmega-chain",
    )
  })

  test("a chained command stays visibly chained, one numbered line per segment", () => {
    const body = permissionBodyFromRequest(
      baseRequest({ subject: "npm install && rm -rf /tmp/cache; echo done" }),
    )
    expect(body.split("\n").slice(2)).toEqual([
      "1) npm install",
      "2) rm -rf /tmp/cache",
      "3) echo done",
    ])
  })

  test("bulk payloads collapse to a placeholder with an expand hint", () => {
    const request = baseRequest({
      subject: 'git commit -m "line one\nline two\nline three"',
    })
    const collapsed = permissionBodyFromRequest(request, { hint: true })
    expect(collapsed).toContain("<message, 3 lines>")
    expect(collapsed).not.toContain("line two")
    expect(collapsed).toContain("e expand 1 collapsed payload")
  })

  test("expanding keeps the placeholder and reveals every payload line", () => {
    const request = baseRequest({
      subject: 'git commit -m "line one\nline two\nline three"',
    })
    const expanded = permissionBodyFromRequest(request, {
      expanded: true,
      hint: true,
    })
    expect(expanded).toContain("<message, 3 lines>")
    expect(expanded).toContain("line one")
    expect(expanded).toContain("line two")
    expect(expanded).toContain("line three")
    expect(expanded).toContain("e collapse payloads")
  })

  test("code-consuming segments are never collapsed", () => {
    const body = permissionBodyFromRequest(
      baseRequest({ subject: "bash -c 'echo one\necho two'" }),
    )
    expect(body).toContain("echo two")
    expect(body).not.toContain("<text,")
  })
})

describe("operatorChoicesFromOptions / operatorResultFromSelection", () => {
  test("choices mirror options with index string ids", () => {
    const opts = ["Cancel", "Option A", "Option B"]
    const choices = operatorChoicesFromOptions(opts)
    expect(choices.items).toEqual(opts)
    expect(choices.itemIds).toEqual(["0", "1", "2"])
  })

  test("selection index → option; OOB → cancel", () => {
    const opts = ["A", "B"]
    expect(operatorResultFromSelection(opts, { index: 0 })).toEqual({
      kind: "option",
      index: 0,
    })
    expect(operatorResultFromSelection(opts, { index: 1 })).toEqual({
      kind: "option",
      index: 1,
    })
    expect(operatorResultFromSelection(opts, { index: -1 })).toEqual({
      kind: "cancel",
    })
    expect(operatorResultFromSelection(opts, { index: 9 })).toEqual({
      kind: "cancel",
    })
  })

  test("id string index preferred when valid", () => {
    const opts = ["A", "B", "C"]
    expect(
      operatorResultFromSelection(opts, { index: 0, id: "2" }),
    ).toEqual({ kind: "option", index: 2 })
    // non-decimal / out of range id ignored → use index
    expect(
      operatorResultFromSelection(opts, { index: 1, id: "nope" }),
    ).toEqual({ kind: "option", index: 1 })
  })

  test("cancel / custom constructors", () => {
    expect(operatorCancelResult()).toEqual({ kind: "cancel" })
    expect(operatorCustomResult("typed")).toEqual({
      kind: "custom",
      text: "typed",
    })
  })
})

describe("wireGates", () => {
  test("subscribes exactly permission.gate and operator.gate; dispose removes both", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      })
      const emitter = new EventEmitter()
      try {
        const dispose = wireGates(emitter, shell)
        expect(emitter.listenerCount("permission.gate")).toBe(1)
        expect(emitter.listenerCount("operator.gate")).toBe(1)

        dispose()
        expect(emitter.listenerCount("permission.gate")).toBe(0)
        expect(emitter.listenerCount("operator.gate")).toBe(0)
      } finally {
        shell.dispose()
      }
    })
  })

  test("permission.gate opens overlay and resolves selection through onAccept", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      })
      const emitter = new EventEmitter()
      let resolved: unknown
      const request: PermissionRequest = {
        tool: "run_shell",
        action: "Run shell command",
        subject: "bun test",
        scopes: [],
      }
      try {
        const dispose = wireGates(emitter, shell)
        emitter.emit("permission.gate", {
          request,
          resolve: (outcome: unknown) => {
            resolved = outcome
          },
        })
        expect(shell.overlayKind).toBe("permissions")
        expect(shell.overlayItems).toEqual(["Reject", "Accept once"])

        acceptOverlaySelection(shell)
        expect(resolved).toEqual({ allow: false })

        dispose()
      } finally {
        shell.dispose()
      }
    })
  })

  test("permission.gate paints the collapsed body and expands it on toggle", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 100, rows: 40 },
        run: "idle",
      })
      const emitter = new EventEmitter()
      const request: PermissionRequest = {
        tool: "run_shell",
        action: "Run shell command",
        subject: 'echo start && cat > notes.txt <<EOF\nalpha\nbeta\nEOF',
        scopes: [],
      }
      try {
        const dispose = wireGates(emitter, shell)
        emitter.emit("permission.gate", { request, resolve: () => {} })

        const collapsed = shell.overlayBodyLines.join("\n")
        expect(collapsed).toContain("1) echo start")
        expect(collapsed).toContain("<heredoc, 2 lines>")
        expect(collapsed).not.toContain("alpha")

        expect(toggleOverlayExpand(shell)).toBe(true)
        const expanded = shell.overlayBodyLines.join("\n")
        expect(expanded).toContain("<heredoc, 2 lines>")
        expect(expanded).toContain("alpha")
        expect(expanded).toContain("beta")

        // Full text also lands in the scrollable transcript, which no
        // overlay height cap can clip.
        const streamed = shell.streamLog.map((r) => r.text).join("\n")
        expect(streamed).toContain("alpha")

        expect(toggleOverlayExpand(shell)).toBe(true)
        expect(shell.overlayBodyLines.join("\n")).not.toContain("alpha")

        dispose()
      } finally {
        shell.dispose()
      }
    })
  })

  test("operator.gate opens overlay and resolves selection through onAccept", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 80, rows: 24 },
        run: "idle",
      })
      const emitter = new EventEmitter()
      let resolved: unknown
      try {
        const dispose = wireGates(emitter, shell)
        emitter.emit("operator.gate", {
          question: "Proceed?",
          options: ["Cancel", "Continue"],
          resolve: (result: unknown) => {
            resolved = result
          },
        })
        expect(shell.overlayKind).toBe("operator")
        expect(shell.overlayItems).toEqual(["Cancel", "Continue"])

        acceptOverlaySelection(shell)
        expect(resolved).toEqual({ kind: "option", index: 0 })

        dispose()
      } finally {
        shell.dispose()
      }
    })
  })

  test("gate content reaches the transcript only after the operator decides", async () => {
    await withTestRenderer(async (h) => {
      const shell = createAppShell(h.renderer, {
        terminal: { columns: 96, rows: 30 },
        run: "idle",
      })
      const emitter = new EventEmitter()
      const request: PermissionRequest = {
        tool: "run_shell",
        action: "Run shell command",
        subject: "ls -la ~/.corbits/projects",
        scopes: [],
      }
      try {
        const dispose = wireGates(emitter, shell)
        emitter.emit("permission.gate", { request, resolve: () => {} })

        // The overlay is showing this text; a transcript copy directly above it
        // reads as a second, unrelated request.
        expect(
          shell.streamLog.filter((r) => r.meta === "permission"),
        ).toHaveLength(0)

        acceptOverlaySelection(shell)

        const recorded = shell.streamLog
          .filter((r) => r.meta === "permission")
          .map((r) => r.text)
          .join("\n")
        expect(recorded).toContain("ls -la ~/.corbits/projects")
        expect(recorded).toContain("Reject")

        dispose()
      } finally {
        shell.dispose()
      }
    })
  })
})

describe("permission overlay height", () => {
  const openGate = (shell: AppShell, scopeCount: number): void => {
    const emitter = new EventEmitter()
    wireGates(emitter, shell)
    emitter.emit("permission.gate", {
      request: {
        tool: "run_shell",
        action: "Run shell command",
        subject: "ls -la ~/.corbits/projects 2>/dev/null | head -40",
        scopes: Array.from({ length: scopeCount }, (_, i) => ({
          id: `s${i}`,
          label: `Always allow scope ${i}`,
          pattern: `p${i}`,
        })),
      },
      resolve: () => {},
    })
  }

  const hostRowsFor = async (
    rows: number,
    scopeCount: number,
  ): Promise<number> => {
    let height = -1
    await withTestRenderer(
      async (h) => {
        const shell = createAppShell(h.renderer, {
          terminal: { columns: 96, rows },
          run: "idle",
        })
        try {
          openGate(shell, scopeCount)
          height = shell.layout.heights.overlay_host
        } finally {
          shell.dispose()
        }
      },
      { width: 96, height: rows },
    )
    return height
  }

  test("tracks item count, not terminal height", async () => {
    const short = await hostRowsFor(30, 1)
    const tall = await hostRowsFor(60, 1)
    expect(short).toBe(tall)

    // Two extra choices cost exactly two extra rows: the choices are
    // single-spaced, so the list is one row per item.
    expect(await hostRowsFor(60, 3)).toBe(tall + 2)
  })

  test("caps rather than growing, and the list scrolls inside the cap", async () => {
    const rows = 40
    const capped = await hostRowsFor(rows, 40)
    expect(capped).toBeLessThanOrEqual(Math.floor(rows * OVERLAY_MAX_FRACTION))
    // Capped means the viewport holds fewer items than exist, not that rows
    // spill outside the host.
    expect(capped).toBeLessThan(await hostRowsFor(rows, 1) + 40)
  })
})
