/**
 * CL-5540: the onboarding provider picker and the satellite list modals
 * (session resume, session mode) mount their own renderer and must disable
 * DEC mouse reporting, unlike the main shell, or the terminal never gets
 * button-1 drags to run its own text selection in these pickers. These
 * tests mock `@opentui/core` so the real (non-test-injected)
 * `createCliRenderer` branch runs, and assert on the options it was
 * actually called with.
 */
import { afterAll, describe, expect, mock, test } from "bun:test"
import type { Harness } from "./harness.js"

type CapturedRendererOptions = {
  readonly useMouse?: boolean
  readonly enableMouseMovement?: boolean
}

const capturedOptions: CapturedRendererOptions[] = []
const mountedHarnesses: Harness[] = []

// The mock must be registered before anything (including this file's own
// helpers) does a real `@opentui/core` import, or that import wins the module
// cache and the mock never takes effect. Every dependency below is loaded
// with a dynamic `import()` after `mock.module` for that reason.
const realCore = await import("@opentui/core")

mock.module("@opentui/core", () => ({
  ...realCore,
  createCliRenderer: async (options: CapturedRendererOptions) => {
    capturedOptions.push(options)
    const { createHarness } = await import("./harness.js")
    const harness = await createHarness({ width: 80, height: 24 })
    mountedHarnesses.push(harness)
    return harness.renderer
  },
}))

// `mock.module` replaces the shared module cache for the whole test process,
// not just this file — every other test that imports `@opentui/core` runs in
// the same process. Put the real module back once this file is done so a
// later un-injected `createCliRenderer` caller does not silently get this
// fake harness renderer instead.
afterAll(() => {
  mock.module("@opentui/core", () => realCore)
})

const { runListModal } = await import("./list-modal.js")
const { runProviderSetup } = await import("./provider-setup.js")

async function waitForMount(): Promise<void> {
  for (let i = 0; i < 100 && capturedOptions.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("default renderer mount disables DEC mouse reporting (CL-5540)", () => {
  test("runListModal", async () => {
    capturedOptions.length = 0
    // Fire-and-forget: the mounted renderer never resolves this promise in
    // this test (nothing presses a key), so only await the mount itself.
    void runListModal({
      title: "resume session",
      options: [{ id: "s-1", label: "First session" }],
    })
    await waitForMount()
    expect(capturedOptions).toHaveLength(1)
    expect(capturedOptions[0]?.useMouse).toBe(false)
    expect(capturedOptions[0]?.enableMouseMovement).toBe(false)
    mountedHarnesses.pop()?.destroy()
  })

  test("runProviderSetup", async () => {
    capturedOptions.length = 0
    void runProviderSetup({
      onSubmit: async () => undefined,
      showTelemetryNotice: false,
    })
    await waitForMount()
    expect(capturedOptions).toHaveLength(1)
    expect(capturedOptions[0]?.useMouse).toBe(false)
    expect(capturedOptions[0]?.enableMouseMovement).toBe(false)
    mountedHarnesses.pop()?.destroy()
  })
})
