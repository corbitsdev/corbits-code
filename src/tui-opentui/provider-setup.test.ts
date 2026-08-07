import { describe, expect, test } from "bun:test"

import { createHarness, type Harness } from "./harness.js"
import {
  ALTERNATE_ROW_IDS,
  CHROME_ROWS,
  CUSTOM_CHOICE_ID,
  failureGuidance,
  LOGIN_CANCELLED_MESSAGE,
  LOGIN_TIMEOUT_MESSAGE,
  maskEcho,
  maskSecret,
  modelChoiceRows,
  modelFromRowId,
  providerChoiceById,
  providerChoiceRows,
  providerChoices,
  runProviderSetup,
  secretFromMaskedEdit,
  stepHeadline,
  stepReady,
  stepsFor,
  summaryRows,
  TYPE_MODEL_ID,
  type OAuthLoginStarter,
  type ProviderFormValues,
  type ProviderSetupSubmit,
  type SubmitOpts,
} from "./provider-setup.js"

const EMPTY: ProviderFormValues = {
  name: "",
  baseURL: "",
  apiKey: "",
  model: "",
}

describe("provider setup pure helpers", () => {
  test("only the API key may be left blank", () => {
    expect(stepReady("name", "")).toBe(false)
    expect(stepReady("name", "  ")).toBe(false)
    expect(stepReady("name", "openai")).toBe(true)
    expect(stepReady("apiKey", "")).toBe(true)
  })

  test("secrets render as capped bullets", () => {
    expect(maskSecret("sk-abc")).toBe("●●●●●●")
    expect(maskSecret("x".repeat(50))).toHaveLength(16)
  })

  test("keys of any length round-trip through the input echo", () => {
    // Mirrors onInput: each keystroke folds the echo back into the secret,
    // then the input is re-mirrored as bullets.
    const typeKey = (key: string): string => {
      let secret = ""
      let display = ""
      for (const ch of key) {
        display = display + ch
        secret = secretFromMaskedEdit(secret, display)
        display = maskEcho(secret)
      }
      return secret
    }
    expect(typeKey("sk-abc")).toBe("sk-abc")
    const long = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"
    expect(typeKey(long)).toBe(long)
  })

  test("masked edits fold back into the real secret", () => {
    let secret = ""
    secret = secretFromMaskedEdit(secret, "s")
    secret = secretFromMaskedEdit(secret, "●k")
    expect(secret).toBe("sk")
    expect(secretFromMaskedEdit(secret, "●")).toBe("s")
    expect(secretFromMaskedEdit(secret, "")).toBe("")
  })

  test("a picked provider takes three steps, custom takes five", () => {
    const openai = providerChoiceById("openai")
    expect(openai?.baseURL).toBe("https://api.openai.com/v1")
    expect(stepsFor(openai ?? null)).toEqual(["provider", "apiKey", "model"])
    // A subscription provider swaps the paste for a sign-in, same three steps.
    expect(stepsFor(providerChoiceById("codex") ?? null)).toEqual([
      "provider",
      "login",
      "model",
    ])
    expect(stepsFor(providerChoiceById(CUSTOM_CHOICE_ID) ?? null)).toEqual([
      "provider",
      "name",
      "baseURL",
      "apiKey",
      "model",
    ])
  })

  test("the pick-list carries known providers and ends with custom", () => {
    const choices = providerChoices()
    const ids = choices.map((c) => c.id)
    expect(ids).toContain("openai")
    expect(ids).toContain("opencode-go")
    expect(ids).toContain("anthropic")
    expect(ids.at(-1)).toBe(CUSTOM_CHOICE_ID)
    // Subscription providers are pickable on a first run: their step is a
    // browser sign-in rather than a paste, not an exclusion.
    expect(ids).toContain("codex")
    expect(ids).toContain("xai")
    for (const choice of choices) {
      if (choice.custom) continue
      expect(choice.baseURL.length).toBeGreaterThan(0)
      expect(choice.defaultModel.length).toBeGreaterThan(0)
    }
    expect(providerChoiceRows(choices)[0]?.label).toContain("OpenAI")
  })

  test("model rows come from the provider catalog plus a free-text escape", () => {
    const openai = providerChoiceById("openai")
    expect(openai).toBeDefined()
    if (openai === undefined) return
    const rows = modelChoiceRows(openai)
    expect(rows.map((r) => r.id)).toContain(`openai:${openai.defaultModel}`)
    expect(rows.at(-1)?.id).toBe(TYPE_MODEL_ID)
    expect(modelFromRowId("openai", "openai:gpt-5.4")).toBe("gpt-5.4")
  })

  test("step headline names the step and how many remain", () => {
    expect(stepHeadline(["provider", "apiKey", "model"], 0)).toBe(
      "step 1 of 3 · provider",
    )
    expect(stepHeadline(["provider", "apiKey", "model"], 2)).toBe(
      "step 3 of 3 · model",
    )
  })

  test("summary rows mark done, current, and pending steps", () => {
    const values: ProviderFormValues = { ...EMPTY, name: "openai" }
    const choice = providerChoiceById("openai") ?? null
    const rows = summaryRows(["provider", "apiKey", "model"], 1, values, choice)
    expect(rows[0]).toMatchObject({ state: "done", value: "OpenAI API — API key" })
    expect(rows[1]?.state).toBe("current")
    expect(rows[2]).toMatchObject({ state: "pending", value: "—" })
  })

  test("the API key never appears in a summary row", () => {
    const values: ProviderFormValues = { ...EMPTY, apiKey: "sk-secret" }
    const rows = summaryRows(["provider", "apiKey", "model"], 2, values, null)
    const line = rows[1]?.value ?? ""
    expect(line).not.toContain("sk-secret")
    expect(line).toContain("●")
  })

  test("a blank key is summarized as keyless", () => {
    const rows = summaryRows(["provider", "apiKey", "model"], 2, EMPTY, null)
    expect(rows[1]?.value).toBe("keyless")
  })

  test("failures say what to fix", () => {
    expect(failureGuidance("testing", null)).toContain("base url")
    expect(failureGuidance("saving", null)).toContain("settings could not be written")
  })
})

async function mountSetup(
  onSubmit: ProviderSetupSubmit = async () => {},
  showTelemetryNotice = false,
): Promise<{ done: Promise<boolean>; harness: Harness }> {
  const harness = await createHarness({ width: 80, height: 30 })
  const done = runProviderSetup({
    onSubmit,
    showTelemetryNotice,
    createRenderer: async () => harness.renderer,
  })
  await harness.renderOnce()
  return { done, harness }
}

describe("root's fixed-row chrome budget", () => {
  test("mounts exactly the rows CHROME_ROWS and ALTERNATE_ROW_IDS name", async () => {
    const { harness, done } = await mountSetup()
    try {
      const surface = harness.root
        .getChildren()
        .find((child) => child.id === "provider-setup")
      expect(surface).toBeDefined()
      // rootPadding is root's own paddingTop, not a child — every other
      // CHROME_ROWS entry plus every alternate-step row is one child each.
      // A row mounted without a matching entry in either list throws this
      // off, so the bug class this guards against (a row added to `root`
      // without being named anywhere) fails here rather than only showing
      // up as garbled text on a short terminal.
      const expectedChildCount =
        CHROME_ROWS.filter((row) => row.id !== "rootPadding").length +
        ALTERNATE_ROW_IDS.length
      expect(surface?.getChildren().length).toBe(expectedChildCount)
    } finally {
      harness.pressKey("Ctrl+C")
      await done
      harness.destroy()
    }
  })
})

function type(harness: Harness, text: string): void {
  for (const ch of text) harness.pressKey(ch)
}

/** ESC needs a disambiguation delay on the mock stdin path. */
async function pressEscape(harness: Harness): Promise<void> {
  harness.pressKey("Escape")
  await new Promise((r) => setTimeout(r, 60))
  await harness.renderOnce()
}

/** Move the pick-list to `id`, then accept it. */
async function pickRow(
  harness: Harness,
  ids: readonly string[],
  id: string,
): Promise<void> {
  const target = ids.indexOf(id)
  for (let i = 0; i < target; i++) harness.pressKey("ARROW_DOWN")
  harness.pressKey("Enter")
  await harness.renderOnce()
}

const PROVIDER_IDS = providerChoiceRows().map((r) => r.id)

/** Pick OpenAI, type a key, accept its default model. */
async function connectOpenAI(harness: Harness, key = "sk-key"): Promise<void> {
  await pickRow(harness, PROVIDER_IDS, "openai")
  type(harness, key)
  harness.pressKey("Enter")
  await harness.renderOnce()
  harness.pressKey("Enter")
  await harness.renderOnce()
}

/** Walk the custom path end to end. */
async function connectCustom(harness: Harness): Promise<void> {
  await pickRow(harness, PROVIDER_IDS, CUSTOM_CHOICE_ID)
  type(harness, "firepass")
  harness.pressKey("Enter")
  type(harness, "https://api.example.com")
  harness.pressKey("Enter")
  type(harness, "sk-key")
  harness.pressKey("Enter")
  type(harness, "fp-small")
  harness.pressKey("Enter")
  await harness.renderOnce()
}

const AUTHORIZE_URL = "https://auth.example.com/authorize?code_challenge=abc"

/** Let queued promise callbacks land, then repaint. */
async function flush(harness: Harness): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await harness.renderOnce()
}

/**
 * Mount with an injected login driver. No test may open a browser or bind a
 * port, so the real PKCE/loopback path is never reached from here.
 */
async function mountLogin(opts: {
  start: OAuthLoginStarter
  onSubmit?: ProviderSetupSubmit
  loginTimeoutMs?: number
}): Promise<{ done: Promise<boolean>; harness: Harness }> {
  const harness = await createHarness({ width: 80, height: 30 })
  const done = runProviderSetup({
    onSubmit: opts.onSubmit ?? (async () => {}),
    showTelemetryNotice: false,
    createRenderer: async () => harness.renderer,
    startLogin: opts.start,
    ...(opts.loginTimeoutMs !== undefined
      ? { loginTimeoutMs: opts.loginTimeoutMs }
      : {}),
  })
  await harness.renderOnce()
  return { done, harness }
}

describe("runProviderSetup sign-in", () => {
  test("a subscription provider signs in in place and persists the selection", async () => {
    const seen: ProviderFormValues[] = []
    const opts: SubmitOpts[] = []
    let complete: (result: { profile: string }) => void = () => {}
    const { done, harness } = await mountLogin({
      start: async ({ kind, profile }) => {
        expect(kind).toBe("codex")
        expect(profile).toBe("default")
        return {
          authorizeUrl: AUTHORIZE_URL,
          completed: new Promise<{ profile: string }>((resolve) => {
            complete = resolve
          }),
          cancel: () => {},
        }
      },
      onSubmit: async (values, _setPhase, o) => {
        seen.push({ ...values })
        opts.push(o)
      },
    })
    await pickRow(harness, PROVIDER_IDS, "codex")
    await flush(harness)
    const waiting = harness.captureCharFrame()
    expect(waiting).toContain("step 2 of 3")
    expect(waiting).toContain("sign in")
    expect(waiting).toContain("auth.example.com/authorize")
    expect(waiting).toContain("waiting for browser sign-in")

    complete({ profile: "default" })
    await flush(harness)
    expect(harness.captureCharFrame()).toContain("step 3 of 3")

    harness.pressKey("Enter")
    await harness.renderOnce()
    expect(await done).toBe(true)
    expect(seen[0]?.name).toBe("codex/default")
    // A signed-in provider never carries a key through the form.
    expect(seen[0]?.apiKey).toBe("")
    expect(opts[0]?.oauth).toEqual({
      kind: "codex",
      profile: "default",
      providerName: "codex/default",
    })
  })

  test("a denied sign-in says so and Enter retries it", async () => {
    let starts = 0
    const { done, harness } = await mountLogin({
      start: async () => {
        starts += 1
        return {
          authorizeUrl: AUTHORIZE_URL,
          completed:
            starts === 1
              ? Promise.reject(new Error("access denied by the user"))
              : new Promise<{ profile: string }>(() => {}),
          cancel: () => {},
        }
      },
    })
    await pickRow(harness, PROVIDER_IDS, "codex")
    await flush(harness)
    const failed = harness.captureCharFrame()
    expect(failed).toContain("access denied by the user")
    expect(failed).toContain("enter to try signing in again")

    harness.pressKey("Enter")
    await flush(harness)
    expect(starts).toBe(2)
    expect(harness.captureCharFrame()).toContain("waiting for browser sign-in")
    harness.pressKey("Ctrl+C")
    expect(await done).toBe(false)
  })

  test("a sign-in that never returns times out rather than hanging", async () => {
    let cancelled = 0
    const { done, harness } = await mountLogin({
      loginTimeoutMs: 5,
      start: async () => ({
        authorizeUrl: AUTHORIZE_URL,
        completed: new Promise<{ profile: string }>(() => {}),
        cancel: () => {
          cancelled += 1
        },
      }),
    })
    await pickRow(harness, PROVIDER_IDS, "codex")
    await new Promise((r) => setTimeout(r, 30))
    await harness.renderOnce()
    const frame = harness.captureCharFrame()
    expect(frame).toContain(LOGIN_TIMEOUT_MESSAGE)
    expect(frame).toContain("enter to try signing in again")
    expect(cancelled).toBeGreaterThan(0)
    harness.pressKey("Ctrl+C")
    expect(await done).toBe(false)
  })

  test("Escape abandons a sign-in and returns to the provider list", async () => {
    let cancelled = 0
    let aborted = false
    const { done, harness } = await mountLogin({
      start: async ({ signal }) => {
        signal.addEventListener("abort", () => {
          aborted = true
        })
        return {
          authorizeUrl: AUTHORIZE_URL,
          completed: new Promise<{ profile: string }>(() => {}),
          cancel: () => {
            cancelled += 1
          },
        }
      },
    })
    await pickRow(harness, PROVIDER_IDS, "codex")
    await flush(harness)
    await pressEscape(harness)
    const frame = harness.captureCharFrame()
    expect(frame).toContain("step 1 of 3")
    expect(frame).toContain(LOGIN_CANCELLED_MESSAGE)
    expect(frame).toContain("pick a provider to start over")
    expect(cancelled).toBeGreaterThan(0)
    expect(aborted).toBe(true)
    harness.pressKey("Ctrl+C")
    expect(await done).toBe(false)
  })

  test("a late resolution from an abandoned attempt cannot move the screen", async () => {
    let complete: (result: { profile: string }) => void = () => {}
    const { done, harness } = await mountLogin({
      start: async () => ({
        authorizeUrl: AUTHORIZE_URL,
        completed: new Promise<{ profile: string }>((resolve) => {
          complete = resolve
        }),
        cancel: () => {},
      }),
    })
    await pickRow(harness, PROVIDER_IDS, "codex")
    await flush(harness)
    await pressEscape(harness)
    complete({ profile: "default" })
    await flush(harness)
    expect(harness.captureCharFrame()).toContain("step 1 of 3")
    harness.pressKey("Ctrl+C")
    expect(await done).toBe(false)
  })
})

describe("runProviderSetup", () => {
  test("opens on the provider pick-list", async () => {
    const { done, harness } = await mountSetup()
    await harness.renderOnce()
    const frame = harness.captureCharFrame()
    expect(frame).toContain("setup")
    expect(frame).toContain("step 1 of 3")
    expect(frame).toContain("OpenAI")
    expect(frame).toContain("Custom")
    harness.pressKey("Ctrl+C")
    expect(await done).toBe(false)
  })

  test("picking a known provider prefills base URL and model", async () => {
    const seen: ProviderFormValues[] = []
    const opts: SubmitOpts[] = []
    const { done, harness } = await mountSetup(async (values, _phase, o) => {
      seen.push({ ...values })
      opts.push(o)
    })
    await pickRow(harness, PROVIDER_IDS, "openai")
    // Two steps left: only the key is typed.
    expect(harness.captureCharFrame()).toContain("step 2 of 3")
    type(harness, "sk-key")
    harness.pressKey("Enter")
    await harness.renderOnce()
    expect(harness.captureCharFrame()).toContain("step 3 of 3")
    harness.pressKey("Enter")
    await harness.renderOnce()

    expect(await done).toBe(true)
    const openai = providerChoiceById("openai")
    expect(seen[0]).toEqual({
      name: "openai",
      baseURL: "https://api.openai.com/v1",
      apiKey: "sk-key",
      model: openai?.defaultModel ?? "",
    })
    expect(opts[0]?.preset?.id).toBe("openai")
    expect(opts[0]?.preset?.models.length).toBeGreaterThan(1)
  })

  test("the custom path keeps the full manual form", async () => {
    const seen: ProviderFormValues[] = []
    const opts: SubmitOpts[] = []
    const { done, harness } = await mountSetup(async (values, _phase, o) => {
      seen.push({ ...values })
      opts.push(o)
    })
    await pickRow(harness, PROVIDER_IDS, CUSTOM_CHOICE_ID)
    expect(harness.captureCharFrame()).toContain("step 2 of 5")
    type(harness, "firepass")
    harness.pressKey("Enter")
    type(harness, "https://api.example.com")
    harness.pressKey("Enter")
    type(harness, "sk-key")
    harness.pressKey("Enter")
    type(harness, "fp-small")
    harness.pressKey("Enter")
    await harness.renderOnce()

    expect(await done).toBe(true)
    expect(seen[0]).toEqual({
      name: "firepass",
      baseURL: "https://api.example.com",
      apiKey: "sk-key",
      model: "fp-small",
    })
    expect(opts[0]?.preset).toBeUndefined()
  })

  test("the model pick-list can escape to a typed model id", async () => {
    const seen: ProviderFormValues[] = []
    const { done, harness } = await mountSetup(async (values) => {
      seen.push({ ...values })
    })
    await pickRow(harness, PROVIDER_IDS, "openai")
    type(harness, "sk-key")
    harness.pressKey("Enter")
    await harness.renderOnce()
    const openai = providerChoiceById("openai")
    expect(openai).toBeDefined()
    if (openai === undefined) return
    const modelIds = modelChoiceRows(openai).map((r) => r.id)
    await pickRow(harness, modelIds, TYPE_MODEL_ID)
    type(harness, "gpt-4o")
    harness.pressKey("Enter")
    await harness.renderOnce()
    expect(await done).toBe(true)
    expect(seen[0]?.model).toBe("gpt-4o")
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
    await pickRow(harness, PROVIDER_IDS, CUSTOM_CHOICE_ID)
    harness.pressKey("Enter")
    await harness.renderOnce()
    expect(harness.captureCharFrame()).toContain("step 2 of 5")
    harness.pressKey("Ctrl+C")
    await done
  })

  test("Escape goes back a step", async () => {
    const { done, harness } = await mountSetup()
    await pickRow(harness, PROVIDER_IDS, "openai")
    expect(harness.captureCharFrame()).toContain("step 2 of 3")
    await pressEscape(harness)
    expect(harness.captureCharFrame()).toContain("step 1 of 3")
    harness.pressKey("Ctrl+C")
    await done
  })

  test("Escape on the first step stays put", async () => {
    const { done, harness } = await mountSetup()
    await pressEscape(harness)
    expect(harness.captureCharFrame()).toContain("step 1 of 3")
    harness.pressKey("Ctrl+C")
    await done
  })

  test("a full-length API key reaches onSubmit intact", async () => {
    const key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"
    const seen: ProviderFormValues[] = []
    const { done, harness } = await mountSetup(async (values) => {
      seen.push({ ...values })
    })
    await connectOpenAI(harness, key)
    expect(await done).toBe(true)
    expect(seen[0]?.apiKey).toBe(key)
  })

  test("the typed API key is never painted in the clear", async () => {
    const { done, harness } = await mountSetup()
    await pickRow(harness, PROVIDER_IDS, "openai")
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
    await connectOpenAI(harness)
    expect(harness.captureCharFrame()).toContain("testing connection")

    advance("saving")
    await harness.renderOnce()
    expect(harness.captureCharFrame()).toContain("writing settings")

    finish()
    expect(await done).toBe(true)
  })

  test("a failed connection test shows the error, guidance, and save-anyway", async () => {
    const attempts: boolean[] = []
    const { done, harness } = await mountSetup(
      async (_values, _setPhase, opts) => {
        attempts.push(opts.skipValidation)
        if (!opts.skipValidation) throw new Error("connection refused")
      },
    )
    await connectOpenAI(harness)
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
    await connectCustom(harness)
    await harness.renderOnce()
    const frame = harness.captureCharFrame()
    expect(frame).toContain("disk full")
    expect(frame).not.toContain("save anyway")
    harness.pressKey("Ctrl+C")
    expect(await done).toBe(false)
  })

  test("Ctrl+C during a sign-in resolves false and closes the flow", async () => {
    let cancelled = 0
    const { done, harness } = await mountLogin({
      start: async () => ({
        authorizeUrl: AUTHORIZE_URL,
        completed: new Promise<{ profile: string }>(() => {}),
        cancel: () => {
          cancelled += 1
        },
      }),
    })
    await pickRow(harness, PROVIDER_IDS, "codex")
    await harness.renderOnce()
    harness.pressKey("Ctrl+C")
    expect(await done).toBe(false)
    expect(cancelled).toBeGreaterThan(0)
  })

  test("Ctrl+C before submit resolves false", async () => {
    let submits = 0
    const { done, harness } = await mountSetup(async () => {
      submits += 1
    })
    await pickRow(harness, PROVIDER_IDS, "openai")
    type(harness, "sk-key")
    harness.pressKey("Ctrl+C")
    expect(await done).toBe(false)
    expect(submits).toBe(0)
  })
})

/**
 * Onboarding tells the user to paste, so paste is driven here as real
 * bracketed-paste bytes (ESC[200~ … ESC[201~) through mock stdin. Asserting a
 * handler is registered would pass while paste was broken.
 */
describe("runProviderSetup paste", () => {
  /** Pick OpenAI, paste `key`, accept the default model, return what was saved. */
  async function pasteKey(
    key: string,
  ): Promise<{ values: ProviderFormValues | null; frame: string }> {
    let seen: ProviderFormValues | null = null
    const { done, harness } = await mountSetup(async (values) => {
      seen = values
    })
    try {
      await pickRow(harness, PROVIDER_IDS, "openai")
      await harness.mockInput.pasteBracketedText(key)
      await harness.renderOnce()
      const frame = harness.captureCharFrame()
      harness.pressKey("Enter")
      await harness.renderOnce()
      harness.pressKey("Enter")
      await harness.renderOnce()
      await done
      return { values: seen, frame }
    } finally {
      harness.destroy()
    }
  }

  test("a pasted key lands in the field, never echoed in the clear", async () => {
    const key = "sk-proj-pasted-key-0123456789"
    const { values, frame } = await pasteKey(key)
    expect(values?.apiKey).toBe(key)
    expect(frame).not.toContain(key)
  })

  test("a key pasted with its trailing newline is not submitted early", async () => {
    const { values } = await pasteKey("sk-trailing\n")
    expect(values?.apiKey).toBe("sk-trailing")
    expect(values?.model.length).toBeGreaterThan(0)
  })

  test("a key longer than the input default is not silently truncated", async () => {
    const key = `sk-${"x".repeat(4000)}`
    const { values } = await pasteKey(key)
    expect(values?.apiKey).toBe(key)
  })
})
