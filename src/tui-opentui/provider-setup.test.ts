import { describe, expect, test } from "bun:test"

import { createHarness, type Harness } from "./harness.js"
import {
  fieldSummaryLine,
  maskSecret,
  providerFieldReady,
  runProviderSetup,
  secretFromMaskedEdit,
  stepHeadline,
  type ProviderFormValues,
  type ProviderSetupSubmit,
} from "./provider-setup.js"

const EMPTY: ProviderFormValues = {
  name: "",
  baseURL: "",
  apiKey: "",
  model: "",
}

describe("provider setup pure helpers", () => {
  test("only the API key may be left blank", () => {
    expect(providerFieldReady("name", "")).toBe(false)
    expect(providerFieldReady("name", "  ")).toBe(false)
    expect(providerFieldReady("name", "openai")).toBe(true)
    expect(providerFieldReady("apiKey", "")).toBe(true)
  })

  test("secrets render as capped bullets", () => {
    expect(maskSecret("sk-abc")).toBe("●●●●●●")
    expect(maskSecret("x".repeat(50))).toHaveLength(16)
  })

  test("masked edits fold back into the real secret", () => {
    let secret = ""
    secret = secretFromMaskedEdit(secret, "s")
    secret = secretFromMaskedEdit(secret, "●k")
    expect(secret).toBe("sk")
    expect(secretFromMaskedEdit(secret, "●")).toBe("s")
    expect(secretFromMaskedEdit(secret, "")).toBe("")
  })

  test("step headline names the current field", () => {
    expect(stepHeadline(0)).toContain("Step 1 of 4: Provider name")
    expect(stepHeadline(3)).toContain("Step 4 of 4: Default model")
  })

  test("summary rows mark done, current, and pending fields", () => {
    const values: ProviderFormValues = { ...EMPTY, name: "openai" }
    expect(fieldSummaryLine("name", 0, 1, values)).toContain("openai")
    expect(fieldSummaryLine("baseURL", 1, 1, values)).toStartWith("›")
    expect(fieldSummaryLine("model", 3, 1, values)).toContain("—")
  })

  test("the API key never appears in a summary row", () => {
    const values: ProviderFormValues = { ...EMPTY, apiKey: "sk-secret" }
    const line = fieldSummaryLine("apiKey", 2, 3, values)
    expect(line).not.toContain("sk-secret")
    expect(line).toContain("●")
  })
})

async function mountSetup(
  onSubmit: ProviderSetupSubmit = async () => {},
  showTelemetryNotice = false,
): Promise<{ done: Promise<boolean>; harness: Harness }> {
  const harness = await createHarness({ width: 80, height: 24 })
  const done = runProviderSetup({
    onSubmit,
    showTelemetryNotice,
    createRenderer: async () => harness.renderer,
  })
  await harness.renderOnce()
  return { done, harness }
}

function type(harness: Harness, text: string): void {
  for (const ch of text) harness.pressKey(ch)
}

/** ESC needs a disambiguation delay on the mock stdin path. */
async function pressEscape(harness: Harness): Promise<void> {
  harness.pressKey("Escape")
  await new Promise((r) => setTimeout(r, 60))
  await harness.renderOnce()
}

async function fillAllFields(harness: Harness): Promise<void> {
  type(harness, "openai")
  harness.pressKey("Enter")
  type(harness, "https://api.example.com")
  harness.pressKey("Enter")
  type(harness, "sk-key")
  harness.pressKey("Enter")
  type(harness, "gpt-4o")
  harness.pressKey("Enter")
  await harness.renderOnce()
}

describe("runProviderSetup", () => {
  test("shows the first step and all field labels on mount", async () => {
    const { done, harness } = await mountSetup()
    await harness.renderOnce()
    const frame = harness.captureCharFrame()
    expect(frame).toContain("Provider setup")
    expect(frame).toContain("Step 1 of 4")
    expect(frame).toContain("Provider name")
    expect(frame).toContain("Base URL")
    expect(frame).toContain("API key")
    expect(frame).toContain("Default model")
    harness.pressKey("Ctrl+C")
    expect(await done).toBe(false)
  })

  test("shows the telemetry notice only when asked to", async () => {
    const shown = await mountSetup(async () => {}, true)
    await shown.harness.renderOnce()
    expect(shown.harness.captureCharFrame()).toContain("telemetry")
    shown.harness.pressKey("Ctrl+C")
    await shown.done

    const hidden = await mountSetup()
    await hidden.harness.renderOnce()
    expect(hidden.harness.captureCharFrame()).not.toContain("telemetry")
    hidden.harness.pressKey("Ctrl+C")
    await hidden.done
  })

  test("Enter on an empty required field does not advance", async () => {
    const { done, harness } = await mountSetup()
    harness.pressKey("Enter")
    await harness.renderOnce()
    expect(harness.captureCharFrame()).toContain("Step 1 of 4")
    harness.pressKey("Ctrl+C")
    await done
  })

  test("Enter advances to the next field and Escape goes back", async () => {
    const { done, harness } = await mountSetup()
    type(harness, "openai")
    harness.pressKey("Enter")
    await harness.renderOnce()
    expect(harness.captureCharFrame()).toContain("Step 2 of 4")

    await pressEscape(harness)
    expect(harness.captureCharFrame()).toContain("Step 1 of 4")
    harness.pressKey("Ctrl+C")
    await done
  })

  test("Escape on the first field stays put", async () => {
    const { done, harness } = await mountSetup()
    await pressEscape(harness)
    expect(harness.captureCharFrame()).toContain("Step 1 of 4")
    harness.pressKey("Ctrl+C")
    await done
  })

  test("submits the entered values and resolves true", async () => {
    const seen: ProviderFormValues[] = []
    const { done, harness } = await mountSetup(async (values) => {
      seen.push({ ...values })
    })
    await fillAllFields(harness)
    expect(await done).toBe(true)
    expect(seen[0]).toEqual({
      name: "openai",
      baseURL: "https://api.example.com",
      apiKey: "sk-key",
      model: "gpt-4o",
    })
  })

  test("the typed API key is never painted in the clear", async () => {
    const { done, harness } = await mountSetup()
    type(harness, "openai")
    harness.pressKey("Enter")
    type(harness, "https://api.example.com")
    harness.pressKey("Enter")
    type(harness, "sk-secret")
    await harness.renderOnce()
    const frame = harness.captureCharFrame()
    expect(frame).not.toContain("sk-secret")
    expect(frame).toContain("●")
    harness.pressKey("Ctrl+C")
    await done
  })

  test("reports the submit phase while onSubmit runs", async () => {
    let advance: (phase: "testing" | "saving") => void = () => {}
    let finish: () => void = () => {}
    const { done, harness } = await mountSetup((_values, setPhase) => {
      advance = setPhase
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    await fillAllFields(harness)
    expect(harness.captureCharFrame()).toContain("Testing connection")

    advance("saving")
    await harness.renderOnce()
    expect(harness.captureCharFrame()).toContain("Writing settings")

    finish()
    expect(await done).toBe(true)
  })

  test("a failed connection test shows the error and offers save-anyway", async () => {
    const attempts: boolean[] = []
    const { done, harness } = await mountSetup(async (_values, _setPhase, opts) => {
      attempts.push(opts.skipValidation)
      if (!opts.skipValidation) throw new Error("connection refused")
    })
    await fillAllFields(harness)
    await harness.renderOnce()
    const frame = harness.captureCharFrame()
    expect(frame).toContain("connection refused")
    expect(frame).toContain("save anyway")

    harness.pressKey("s", { ctrl: true })
    expect(await done).toBe(true)
    expect(attempts).toEqual([false, true])
  })

  test("a failure while saving does not offer save-anyway", async () => {
    const { done, harness } = await mountSetup(async (_values, setPhase) => {
      setPhase("saving")
      throw new Error("disk full")
    })
    await fillAllFields(harness)
    await harness.renderOnce()
    const frame = harness.captureCharFrame()
    expect(frame).toContain("disk full")
    expect(frame).not.toContain("save anyway")
    harness.pressKey("Ctrl+C")
    expect(await done).toBe(false)
  })

  test("Ctrl+C before submit resolves false", async () => {
    let submits = 0
    const { done, harness } = await mountSetup(async () => {
      submits += 1
    })
    type(harness, "openai")
    harness.pressKey("Ctrl+C")
    expect(await done).toBe(false)
    expect(submits).toBe(0)
  })
})
