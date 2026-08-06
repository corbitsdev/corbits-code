/**
 * First-run provider setup form on OpenTUI.
 *
 * A four-step form rather than a list, so it mounts its own renderables instead
 * of the shared list-overlay kit. Owns paint + input only; the caller owns
 * validation and the settings write via `onSubmit`.
 */

import {
  BoxRenderable,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core"

import { PRODUCT_NAME } from "../branding.js"
import { UI } from "./theme.js"
import { TELEMETRY_NOTICE } from "../telemetry/index.js"

export type ProviderField = "name" | "baseURL" | "apiKey" | "model"

export const PROVIDER_FIELDS: readonly ProviderField[] = [
  "name",
  "baseURL",
  "apiKey",
  "model",
]

export const PROVIDER_FIELD_LABELS: Record<ProviderField, string> = {
  name: "Provider name",
  baseURL: "Base URL",
  apiKey: "API key",
  model: "Default model",
}

export const PROVIDER_FIELD_HINTS: Record<ProviderField, string> = {
  name: "openai, anthropic, ollama, ...",
  baseURL: "https://api.openai.com/v1",
  apiKey: "sk-... (blank for keyless/local)",
  model: "gpt-4o",
}

const PROVIDER_FIELD_STEPS: Record<ProviderField, string> = {
  name: "name it (openai, anthropic, ollama, …)",
  baseURL: "paste the API base URL (include /v1 if required)",
  apiKey: "API key (blank for local/keyless)",
  model: "default model, then Enter to test & save",
}

export type ProviderFormValues = Record<ProviderField, string>

// "testing" covers the connection-check call against the entered credentials;
// "saving" covers the settings write that follows once the test succeeds.
export type SubmitPhase = "testing" | "saving"

const SUBMIT_PHASE_LABEL: Record<SubmitPhase, string> = {
  testing: "Testing connection…",
  saving: "Writing settings…",
}

export type SubmitOpts = {
  // True when the operator chose to save despite a failed connection test —
  // some providers speak chat completions but not /models, so validation
  // cannot be a hard gate.
  readonly skipValidation: boolean
}

export type ProviderSetupSubmit = (
  values: ProviderFormValues,
  setPhase: (phase: SubmitPhase) => void,
  opts: SubmitOpts,
) => Promise<void>

export type ProviderSetupConfig = {
  readonly onSubmit: ProviderSetupSubmit
  /**
   * One-time telemetry disclosure. Shown here so a brand-new install sees it
   * on the same launch the first telemetry event fires, not on a later run.
   */
  readonly showTelemetryNotice: boolean
  /** Renderer factory override for headless mounting in tests. */
  readonly createRenderer?: () => Promise<CliRenderer>
}

const MASK_CHAR = "●"
const MASK_CAP = 16

/**
 * Bullet-render a secret for the read-only summary rows, capped so a long key
 * does not blow out the row width.
 */
export function maskSecret(value: string): string {
  return MASK_CHAR.repeat(Math.min([...value].length, MASK_CAP))
}

/**
 * Bullet-render a secret for the live input echo.
 *
 * Uncapped, unlike `maskSecret`: the echo is what `secretFromMaskedEdit` reads
 * back, so a capped echo would silently discard everything past the cap.
 */
export function maskEcho(value: string): string {
  return MASK_CHAR.repeat([...value].length)
}

export function displayFieldValue(field: ProviderField, value: string): string {
  return field === "apiKey" ? maskSecret(value) : value
}

/** apiKey is optional — blank means a keyless local provider (e.g. Ollama). */
export function providerFieldReady(
  field: ProviderField,
  value: string,
): boolean {
  return field === "apiKey" || value.trim().length > 0
}

/**
 * Fold an edit of the masked apiKey display back into the real secret.
 *
 * The input never holds the key: every keystroke is mirrored back as bullets,
 * so an edit arrives as bullets plus whatever was just typed. Appends and
 * end-of-line deletes round-trip exactly; mid-string edits fall back to
 * truncation, which is why the field is re-typed rather than patched.
 */
export function secretFromMaskedEdit(secret: string, displayed: string): string {
  const chars = [...displayed]
  const typed = chars.filter((c) => c !== MASK_CHAR)
  const keptLength = chars.length - typed.length
  return [...secret].slice(0, keptLength).join("") + typed.join("")
}

export function stepHeadline(fieldIndex: number): string {
  const field = PROVIDER_FIELDS[fieldIndex] ?? PROVIDER_FIELDS[0]
  if (field === undefined) return ""
  return `Step ${fieldIndex + 1} of ${PROVIDER_FIELDS.length}: ${PROVIDER_FIELD_LABELS[field]} — ${PROVIDER_FIELD_STEPS[field]}`
}

/** One summary row per field: done rows show the value, later rows an em dash. */
export function fieldSummaryLine(
  field: ProviderField,
  fieldIndex: number,
  activeIndex: number,
  values: ProviderFormValues,
): string {
  const label = PROVIDER_FIELD_LABELS[field].padEnd(16)
  if (fieldIndex < activeIndex) {
    return `  ${label}${displayFieldValue(field, values[field])}`
  }
  if (fieldIndex === activeIndex) {
    return `› ${label}${PROVIDER_FIELD_HINTS[field]}`
  }
  return `  ${label}—`
}

/**
 * Mount the setup form. Resolves true once `onSubmit` completes, false when the
 * operator cancels (Ctrl+C / Ctrl+D) without a successful submit.
 */
export async function runProviderSetup(
  config: ProviderSetupConfig,
): Promise<boolean> {
  const renderer = config.createRenderer
    ? await config.createRenderer()
    : await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })

  const values: ProviderFormValues = {
    name: "",
    baseURL: "",
    apiKey: "",
    model: "",
  }
  let fieldIndex = 0
  let submitting = false
  let submitPhase: SubmitPhase = "testing"
  let submitError: string | null = null
  let saveAnywayOffered = false

  const root = new BoxRenderable(renderer, {
    id: "provider-setup",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: UI.ground,
    paddingTop: 1,
    paddingLeft: 2,
    paddingRight: 2,
  })

  const header = new TextRenderable(renderer, {
    id: "provider-setup-header",
    content: `${PRODUCT_NAME} · Provider setup`,
    fg: UI.inFlightBright,
  })
  const welcome = new TextRenderable(renderer, {
    id: "provider-setup-welcome",
    content: "Welcome — connect an inference provider",
    fg: UI.text,
  })
  const step = new TextRenderable(renderer, {
    id: "provider-setup-step",
    content: stepHeadline(0),
    fg: UI.textDim,
  })
  const switchHint = new TextRenderable(renderer, {
    id: "provider-setup-switch-hint",
    content: "After setup, switch providers with /model",
    fg: UI.textDim,
  })

  const summary = new BoxRenderable(renderer, {
    id: "provider-setup-summary",
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
    paddingTop: 1,
    backgroundColor: UI.ground,
  })
  const summaryRows = PROVIDER_FIELDS.map(
    (field) =>
      new TextRenderable(renderer, {
        id: `provider-setup-field-${field}`,
        content: "",
        fg: UI.textDim,
      }),
  )
  for (const row of summaryRows) summary.add(row)

  const inputFrame = new BoxRenderable(renderer, {
    id: "provider-setup-input-frame",
    width: "100%",
    height: 3,
    flexShrink: 0,
    border: true,
    borderColor: UI.textFaint,
    focusedBorderColor: UI.textDim,
    backgroundColor: UI.ground,
    paddingLeft: 1,
    paddingRight: 1,
  })
  const input = new InputRenderable(renderer, {
    id: "provider-setup-input",
    width: "100%",
    placeholder: PROVIDER_FIELD_HINTS.name,
    backgroundColor: UI.ground,
    focusedBackgroundColor: UI.ground,
    textColor: UI.text,
    cursorColor: UI.text,
    placeholderColor: UI.textFaint,
  })
  inputFrame.add(input)

  const statusLine = new TextRenderable(renderer, {
    id: "provider-setup-status",
    content: "",
    fg: UI.action,
  })
  const telemetry = new TextRenderable(renderer, {
    id: "provider-setup-telemetry",
    content: config.showTelemetryNotice ? TELEMETRY_NOTICE : "",
    fg: UI.textDim,
    visible: config.showTelemetryNotice,
  })
  const footer = new TextRenderable(renderer, {
    id: "provider-setup-footer",
    content: "Enter confirm · Esc back · Ctrl+C cancel",
    fg: UI.textDim,
  })

  root.add(header)
  root.add(welcome)
  root.add(step)
  root.add(switchHint)
  root.add(summary)
  root.add(inputFrame)
  root.add(statusLine)
  root.add(telemetry)
  root.add(footer)
  renderer.root.add(root)

  const currentField = (): ProviderField =>
    PROVIDER_FIELDS[fieldIndex] as ProviderField

  const paint = (): void => {
    step.content = stepHeadline(fieldIndex)
    summaryRows.forEach((row, i) => {
      const field = PROVIDER_FIELDS[i]
      if (field === undefined) return
      row.content = fieldSummaryLine(field, i, fieldIndex, values)
    })
    input.placeholder = PROVIDER_FIELD_HINTS[currentField()]
    if (submitting) {
      statusLine.content = SUBMIT_PHASE_LABEL[submitPhase]
      statusLine.fg = UI.textDim
    } else if (submitError !== null) {
      statusLine.content = saveAnywayOffered
        ? `${submitError} — Enter retry · Ctrl+S save anyway`
        : submitError
      statusLine.fg = UI.action
    } else {
      statusLine.content = ""
    }
  }

  const clearError = (): void => {
    submitError = null
    saveAnywayOffered = false
  }

  const showField = (): void => {
    const field = currentField()
    input.value = field === "apiKey" ? maskEcho(values[field]) : values[field]
    paint()
  }

  let settled = false
  let resolveDone: (submitted: boolean) => void = () => {}
  const done = new Promise<boolean>((resolve) => {
    resolveDone = resolve
  })

  const teardown = (): void => {
    renderer.keyInput.off("keypress", onKey)
    input.off(InputRenderableEvents.ENTER, onEnter)
    input.off(InputRenderableEvents.INPUT, onInput)
    try {
      renderer.root.remove(root)
      root.destroy()
    } catch {
      // already unmounted
    }
    try {
      renderer.destroy()
    } catch {
      // already destroyed
    }
  }

  const settle = (submitted: boolean): void => {
    if (settled) return
    settled = true
    teardown()
    resolveDone(submitted)
  }

  const submit = (skipValidation: boolean): void => {
    submitting = true
    submitPhase = "testing"
    clearError()
    paint()

    // Track the phase locally so the rejection handler knows whether the
    // failure happened during the connection test (retryable and bypassable)
    // or during the settings write.
    let phase: SubmitPhase = "testing"
    const setPhase = (p: SubmitPhase): void => {
      phase = p
      submitPhase = p
      paint()
    }

    config.onSubmit(values, setPhase, { skipValidation }).then(
      () => settle(true),
      (err: unknown) => {
        submitting = false
        submitError = err instanceof Error ? err.message : String(err)
        saveAnywayOffered = phase === "testing"
        paint()
      },
    )
  }

  const advance = (): void => {
    const field = currentField()
    if (!providerFieldReady(field, values[field])) return

    if (fieldIndex < PROVIDER_FIELDS.length - 1) {
      fieldIndex += 1
      clearError()
      showField()
      return
    }

    submit(false)
  }

  function onInput(next: string): void {
    if (submitting) return
    const field = currentField()
    if (field === "apiKey") {
      values.apiKey = secretFromMaskedEdit(values.apiKey, next)
      const masked = maskEcho(values.apiKey)
      if (input.value !== masked) input.value = masked
    } else {
      values[field] = next
    }
    if (submitError !== null) {
      clearError()
      paint()
    }
  }

  function onEnter(): void {
    if (submitting) return
    advance()
  }

  function onKey(key: KeyEvent): void {
    if (settled) return
    if (key.ctrl === true && (key.name === "c" || key.name === "d")) {
      key.preventDefault()
      settle(false)
      return
    }
    if (submitting) {
      key.preventDefault()
      return
    }
    if (key.ctrl === true && key.name === "s") {
      if (!saveAnywayOffered) return
      key.preventDefault()
      submit(true)
      return
    }
    if (key.name === "escape") {
      key.preventDefault()
      if (fieldIndex > 0) {
        fieldIndex -= 1
        clearError()
        showField()
      }
    }
  }

  input.on(InputRenderableEvents.ENTER, onEnter)
  input.on(InputRenderableEvents.INPUT, onInput)
  renderer.keyInput.on("keypress", onKey)
  input.focus()
  showField()

  return done
}
