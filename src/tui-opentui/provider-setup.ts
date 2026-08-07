/**
 * First-run provider setup on OpenTUI.
 *
 * Selection first: the operator picks a known provider from the first-class
 * catalog (which prefills base URL and models), types only the API key, then
 * picks a model. "Custom" falls back to the full manual form for endpoints the
 * catalog does not know.
 *
 * The surface owns paint + input only; the caller owns the connection test and
 * the settings write via `onSubmit`.
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

import {
  FIRST_CLASS_PROVIDERS,
  firstClassPathAsProvider,
  type FirstClassOAuthProvider,
  type FirstClassProviderDef,
} from "../../packages/first-class-providers/src/index.js"
import { CODEX_BASE_URL, CODEX_DEFAULT_MODELS } from "../auth/codex/constants.js"
import { XAI_BASE_URL, XAI_DEFAULT_MODELS } from "../auth/xai/constants.js"
import { PRODUCT_NAME } from "../branding.js"
import { codexProviderName } from "../config/codex-providers.js"
import { xaiProviderName } from "../config/xai-providers.js"
import { TELEMETRY_NOTICE } from "../telemetry/index.js"
import { wrapLines } from "../tui/view/height.js"
import { chromeBudget, type ChromeRow } from "./geometry/chrome-budget.js"
import { resolveSideMargin } from "./geometry/margins.js"
import {
  createListViewport,
  moveActive,
  visibleSlice,
  type ListViewportState,
} from "./list-viewport.js"
import { buildModelsFirstCatalog } from "./model-catalog.js"
import { rampFor, rampLine } from "./ramp.js"
import {
  residualIdFromSelection,
  residualListFromCatalog,
  type ResidualCatalogEntry,
} from "./residuals.js"
import { destroySubtree } from "./teardown.js"
import { UI } from "./theme.js"

export type ProviderField = "name" | "baseURL" | "apiKey" | "model"

/** Placeholder shown in the text input for each free-text step. */
const PROVIDER_FIELD_HINTS: Record<ProviderField, string> = {
  name: "openai, anthropic, ollama, …",
  baseURL: "https://api.openai.com/v1",
  apiKey: "sk-… (blank for keyless/local)",
  model: "gpt-4o",
}

export type ProviderFormValues = Record<ProviderField, string>

/** One screen of the flow. `provider` and `model` can be pick-lists. */
export type SetupStep =
  | "provider"
  | "name"
  | "baseURL"
  | "apiKey"
  | "model"
  | "login"

/** Known-provider path: pick, paste key, pick model. */
export const PRESET_STEPS: readonly SetupStep[] = ["provider", "apiKey", "model"]

/** Subscription path: pick, sign in through the browser, pick model. */
export const OAUTH_STEPS: readonly SetupStep[] = ["provider", "login", "model"]

/** Unknown endpoint: the full manual form, still preceded by the pick-list. */
export const CUSTOM_STEPS: readonly SetupStep[] = [
  "provider",
  "name",
  "baseURL",
  "apiKey",
  "model",
]

const STEP_LABELS: Record<SetupStep, string> = {
  provider: "provider",
  name: "provider name",
  baseURL: "base url",
  apiKey: "api key",
  model: "model",
  login: "sign in",
}

const STEP_PROMPTS: Record<SetupStep, string> = {
  provider: "pick the provider you have a key or subscription for",
  name: "name this provider — you will see it in /model",
  baseURL: "paste the api base url, including /v1 if it needs one",
  apiKey: "paste the api key — leave blank for a keyless local endpoint",
  model: "pick the model to start with",
  login: "authorize in the browser — this window waits for you",
}

// "testing" covers the connection-check call against the entered credentials;
// "saving" covers the settings write that follows once the test succeeds.
export type SubmitPhase = "testing" | "saving"

const SUBMIT_PHASE_LABEL: Record<SubmitPhase, string> = {
  testing: "testing connection",
  saving: "writing settings",
}

/** Catalog id for the manual path. Never written to settings as a name. */
export const CUSTOM_CHOICE_ID = "custom"

/** Pick-list row that drops the model step back to free text. */
export const TYPE_MODEL_ID = "__type_model__"

/**
 * A selectable provider. Preset rows carry everything the settings write needs
 * except the key; the custom row carries nothing and opens the manual form.
 */
export type ProviderChoice = {
  readonly id: string
  readonly label: string
  readonly baseURL: string
  readonly models: readonly string[]
  readonly defaultModel: string
  readonly hint: string
  /** Anthropic Messages protocol rather than OpenAI-compatible chat. */
  readonly anthropic: boolean
  /** OpenCode Go subscription routing. */
  readonly opencodeGo: boolean
  readonly custom: boolean
  /** Browser sign-in flow to run instead of asking for a key. */
  readonly oauth: OAuthKind | null
}

export type OAuthKind = FirstClassOAuthProvider

/** Profile name a first run authorizes under. `/model` can add more later. */
export const DEFAULT_OAUTH_PROFILE = "default"

/**
 * What a signed-in subscription provider resolves to. The endpoint and model
 * list are the same constants the auth stack projects into the catalog, so a
 * first run and a later `/model` connect land on the same provider entry.
 */
const OAUTH_SURFACES: Record<
  OAuthKind,
  {
    readonly baseURL: string
    readonly models: readonly string[]
    readonly hint: string
    readonly providerName: (profile: string) => string
  }
> = {
  codex: {
    baseURL: CODEX_BASE_URL,
    models: CODEX_DEFAULT_MODELS,
    hint: "ChatGPT Plus/Pro subscription",
    providerName: codexProviderName,
  },
  xai: {
    baseURL: XAI_BASE_URL,
    models: XAI_DEFAULT_MODELS,
    hint: "SuperGrok or X Premium+ subscription",
    providerName: xaiProviderName,
  },
}

/** Settings/catalog provider name a profile of `kind` is stored under. */
export function oauthProviderName(kind: OAuthKind, profile: string): string {
  return OAUTH_SURFACES[kind].providerName(profile)
}

function oauthChoice(
  id: string,
  label: string,
  kind: OAuthKind,
): ProviderChoice | null {
  const surface = OAUTH_SURFACES[kind]
  const defaultModel = surface.models[0]
  if (defaultModel === undefined) return null
  return {
    id,
    label,
    baseURL: surface.baseURL,
    models: surface.models,
    defaultModel,
    hint: surface.hint,
    anthropic: false,
    opencodeGo: false,
    custom: false,
    oauth: kind,
  }
}

const CUSTOM_CHOICE: ProviderChoice = {
  id: CUSTOM_CHOICE_ID,
  label: "Custom — any OpenAI-compatible endpoint",
  baseURL: "",
  models: [],
  defaultModel: "",
  hint: "you supply the name, base url and model",
  anthropic: false,
  opencodeGo: false,
  custom: true,
  oauth: null,
}

function choiceFromDef(def: FirstClassProviderDef): ProviderChoice | null {
  if (def.auth !== "api-key") return null
  if (def.baseURL === undefined || def.models === undefined) return null
  const defaultModel = def.defaultModel ?? def.models[0]
  if (defaultModel === undefined) return null
  return {
    id: def.id,
    label: def.label,
    baseURL: def.baseURL,
    models: def.models,
    defaultModel,
    hint: def.authHint ?? "",
    anthropic: def.anthropic === true,
    opencodeGo: def.opencodeGo === true,
    custom: false,
    oauth: null,
  }
}

/**
 * The pick-list, derived from the shared first-class catalog so onboarding and
 * `/model` connect never drift. Subscription providers are listed alongside the
 * key-based ones: their step is a browser sign-in rather than a paste, but a
 * first run must be able to start there.
 */
export function providerChoices(): readonly ProviderChoice[] {
  const out: ProviderChoice[] = []
  for (const def of FIRST_CLASS_PROVIDERS) {
    if (def.auth === "chooser") {
      for (const path of def.paths ?? []) {
        if (path.auth === "oauth" && path.oauth !== undefined) {
          // The path label alone ("ChatGPT — …") drops the vendor, so the
          // parent label carries it into a row read out of context.
          const choice = oauthChoice(
            path.providerId ?? def.id,
            `${def.label} ${path.label}`,
            path.oauth,
          )
          if (choice !== null) out.push(choice)
          continue
        }
        if (path.auth !== "api-key") continue
        const seeded = firstClassPathAsProvider(def, path.id)
        if (seeded === undefined) continue
        const choice = choiceFromDef(seeded)
        if (choice !== null) out.push(choice)
      }
      continue
    }
    if (def.auth === "oauth" && def.oauth !== undefined) {
      const choice = oauthChoice(def.id, def.label, def.oauth)
      if (choice !== null) out.push(choice)
      continue
    }
    const choice = choiceFromDef(def)
    if (choice !== null) out.push(choice)
  }
  out.push(CUSTOM_CHOICE)
  return out
}

export function providerChoiceById(id: string): ProviderChoice | undefined {
  return providerChoices().find((c) => c.id === id)
}

/** Pick-list rows for the provider step. */
export function providerChoiceRows(
  choices: readonly ProviderChoice[] = providerChoices(),
): readonly ResidualCatalogEntry[] {
  return choices.map((c) => ({
    id: c.id,
    label: c.hint.length > 0 ? `${c.label} — ${c.hint}` : c.label,
  }))
}

/**
 * Pick-list rows for the model step, built from the shared models-first
 * catalog so the labels match the `/model` picker (including its cross-product
 * billing warnings). A trailing row escapes to free text for a model id the
 * seeded list does not carry yet.
 */
export function modelChoiceRows(
  choice: ProviderChoice,
): readonly ResidualCatalogEntry[] {
  const catalog = buildModelsFirstCatalog({
    providers: [
      {
        name: choice.id,
        label: choice.label,
        models: choice.models,
        baseURL: choice.baseURL,
        opencodeGo: choice.opencodeGo,
      },
    ],
  })
  return [
    ...catalog.map((option) => ({
      id: option.id,
      label: option.label,
    })),
    { id: TYPE_MODEL_ID, label: "type a model id instead" },
  ]
}

/** `provider:model` → `model`, for a row id produced by the model catalog. */
export function modelFromRowId(providerId: string, rowId: string): string {
  const prefix = `${providerId}:`
  return rowId.startsWith(prefix) ? rowId.slice(prefix.length) : rowId
}

export function stepsFor(choice: ProviderChoice | null): readonly SetupStep[] {
  if (choice === null) return PRESET_STEPS
  if (choice.custom) return CUSTOM_STEPS
  return choice.oauth !== null ? OAUTH_STEPS : PRESET_STEPS
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

/** apiKey is optional — blank means a keyless local provider (e.g. Ollama). */
export function stepReady(step: SetupStep, value: string): boolean {
  return step === "apiKey" || value.trim().length > 0
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

/** `step 2 of 3 · api key` — always says where the operator is and what is left. */
export function stepHeadline(
  steps: readonly SetupStep[],
  index: number,
): string {
  const step = steps[Math.min(Math.max(index, 0), steps.length - 1)]
  if (step === undefined) return ""
  return `step ${index + 1} of ${steps.length} · ${STEP_LABELS[step]}`
}

export type SummaryRow = {
  readonly label: string
  readonly value: string
  readonly state: "done" | "current" | "pending"
}

/** One row per step: settled rows show the value, later rows a dash. */
export function summaryRows(
  steps: readonly SetupStep[],
  index: number,
  values: ProviderFormValues,
  choice: ProviderChoice | null,
): readonly SummaryRow[] {
  return steps.map((step, i) => {
    const state = i < index ? "done" : i === index ? "current" : "pending"
    return {
      label: STEP_LABELS[step],
      value: state === "done" ? settledValue(step, values, choice) : "—",
      state,
    }
  })
}

function settledValue(
  step: SetupStep,
  values: ProviderFormValues,
  choice: ProviderChoice | null,
): string {
  if (step === "provider") return choice?.label ?? values.name
  if (step === "login") return values.name.length > 0 ? values.name : "signed in"
  if (step === "apiKey") {
    return values.apiKey.length > 0 ? maskSecret(values.apiKey) : "keyless"
  }
  if (step === "name") return values.name
  if (step === "baseURL") return values.baseURL
  return values.model
}

/** Render a summary row at a fixed label column. */
export function summaryLine(row: SummaryRow): string {
  const marker = row.state === "current" ? "›" : " "
  return `${marker} ${row.label.padEnd(14)}${row.state === "current" ? "" : row.value}`
}

export function summaryColor(row: SummaryRow): string {
  if (row.state === "done") return UI.done
  if (row.state === "current") return UI.text
  return UI.textFaint
}

/**
 * What the operator should do about a failure. A bare error message leaves a
 * first-run user stuck, so every failure names the field to fix.
 */
export function failureGuidance(
  phase: SubmitPhase,
  choice: ProviderChoice | null,
): string {
  if (phase === "saving") {
    return "settings could not be written — check disk permissions, enter to retry"
  }
  return choice !== null && !choice.custom
    ? "the key was rejected or unreachable — esc to re-enter it, enter to retry, ctrl+s to save anyway"
    : "check the base url and key — esc to go back, enter to retry, ctrl+s to save anyway"
}

/** How long a sign-in may wait on the browser before it gives the screen back. */
export const LOGIN_TIMEOUT_MS = 3 * 60 * 1000

export const LOGIN_TIMEOUT_MESSAGE = "sign-in timed out"

/** Set when the operator escapes a sign-in that was still outstanding. */
export const LOGIN_CANCELLED_MESSAGE = "sign-in cancelled"

/** What the operator should do about a sign-in that did not complete. */
export function loginGuidance(): string {
  return "enter to try signing in again · esc to pick a different provider"
}

/** What the operator should do after abandoning a sign-in. */
export function loginCancelGuidance(): string {
  return "nothing was saved — pick a provider to start over"
}

/** Status line while the browser round-trip is outstanding. */
export const LOGIN_WAITING_LABEL = "waiting for browser sign-in"

export type SubmitOpts = {
  // True when the operator chose to save despite a failed connection test —
  // some providers speak chat completions but not /models, so validation
  // cannot be a hard gate.
  readonly skipValidation: boolean
  /**
   * Catalog metadata for the picked provider. Absent on the custom path. Lets
   * the caller persist the full seeded model list and the protocol flags the
   * four form values cannot express.
   */
  readonly preset?: ProviderPreset
  /**
   * Present when the operator signed in rather than pasting a key. The token
   * is already on disk in the auth store by then, so the caller persists the
   * selection only — never a credential.
   */
  readonly oauth?: OAuthResult
}

export type OAuthResult = {
  readonly kind: OAuthKind
  readonly profile: string
  /** Settings/catalog name the stored profile projects to. */
  readonly providerName: string
}

export type ProviderPreset = {
  readonly id: string
  readonly models: readonly string[]
  readonly anthropic: boolean
  readonly opencodeGo: boolean
}

export type ProviderSetupSubmit = (
  values: ProviderFormValues,
  setPhase: (phase: SubmitPhase) => void,
  opts: SubmitOpts,
) => Promise<void>

/** A login in flight: where to authorize, when it finished, how to abandon it. */
export type OAuthLoginStart = {
  readonly authorizeUrl: string
  readonly completed: Promise<{ profile: string }>
  readonly cancel: () => void
}

export type OAuthLoginStarter = (input: {
  readonly kind: OAuthKind
  readonly profile: string
  readonly signal: AbortSignal
}) => Promise<OAuthLoginStart>

/**
 * Real login: PKCE plus a loopback callback server, per provider. Imported
 * lazily so mounting the surface never binds a port in a test that has
 * injected its own starter.
 */
const defaultLoginStarter: OAuthLoginStarter = async ({
  kind,
  profile,
  signal,
}) => {
  if (kind === "codex") {
    const { startCodexLogin } = await import("../auth/codex/login.js")
    return startCodexLogin({ profile, signal })
  }
  const { startXaiLogin } = await import("../auth/xai/login.js")
  return startXaiLogin({ profile, signal })
}

export type ProviderSetupConfig = {
  readonly onSubmit: ProviderSetupSubmit
  /**
   * One-time telemetry disclosure. Shown here so a brand-new install sees it
   * on the same launch the first telemetry event fires, not on a later run.
   */
  readonly showTelemetryNotice: boolean
  /** Renderer factory override for headless mounting in tests. */
  readonly createRenderer?: () => Promise<CliRenderer>
  /** Login driver override so tests need neither a browser nor a port. */
  readonly startLogin?: OAuthLoginStarter
  /** Sign-in deadline override, in milliseconds. */
  readonly loginTimeoutMs?: number
  /**
   * Skip the provider pick-list and start directly on that provider's
   * apiKey/login step — the inline "connect →" path from the model picker
   * already knows which provider it wants.
   */
  readonly initialProviderId?: string
}

const SUMMARY_SLOTS = CUSTOM_STEPS.length
/** Wrapped rows reserved for the authorize URL and its instruction. */
const LOGIN_ROWS = 4
// The whole first-class catalog plus the custom row fits without scrolling on a
// standard terminal: a first run should see every option it could pick.
const LIST_ROWS_MAX = 10
const LIST_ROWS_MIN = 3
const TELEMETRY_ROWS = 3

/**
 * Every row `root` reserves outside the list step's scrollable region,
 * named 1:1 with the `root.add(...)` calls below (`rootPadding` stands for
 * `root`'s own `paddingTop`, which is not a child but still costs a row).
 * `listHeight()` derives its budget by summing this list instead of
 * carrying a hand-counted integer, so a row added to `root` without a
 * matching entry here is a length mismatch caught by the test that checks
 * `root`'s children against `CHROME_ROWS` + `ALTERNATE_ROW_IDS`, not a
 * guess that only shows up as garbled text on a short terminal.
 *
 * `loginBox`, `inputFrame`, and `telemetry` are deliberately excluded: the
 * step machine only ever shows one of them (or the list) at a time, so they
 * never compete with the list for the same rows.
 */
export const CHROME_ROWS: readonly ChromeRow[] = [
  { id: "rootPadding", rows: 1 },
  { id: "header", rows: 1 },
  { id: "intro", rows: 1 },
  { id: "step", rows: 1 },
  { id: "instruction", rows: 1 },
  { id: "summary", rows: 1 + SUMMARY_SLOTS },
  { id: "listBoxPadding", rows: 1 },
  { id: "statusLine", rows: 1 },
  { id: "guidance", rows: 1 },
  { id: "footer", rows: 1 },
]

/** `root`'s other direct children — never on screen at the same time as the list. */
export const ALTERNATE_ROW_IDS = ["loginBox", "inputFrame", "telemetry"] as const
/**
 * Input capacity. The renderable defaults to 1000 characters and truncates a
 * longer paste silently, which a first run would read as "paste is broken";
 * long-lived service-account keys and JWT-shaped tokens clear that default.
 */
const FIELD_MAX_LENGTH = 16_384
/** Ramp animation tick. Fast enough to read as motion at 30fps paint. */
const RAMP_TICK_MS = 120

/**
 * Mount the setup surface. Resolves true once `onSubmit` completes, false when
 * the operator cancels (Ctrl+C / Ctrl+D) without a successful submit.
 */
export async function runProviderSetup(
  config: ProviderSetupConfig,
): Promise<boolean> {
  const renderer = config.createRenderer
    ? await config.createRenderer()
    : await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
        // Reporting stays off during onboarding, unlike the main shell, so
        // the terminal owns drag-select and its own copy here.
        useMouse: false,
        enableMouseMovement: false,
      })

  const choices = providerChoices()
  const values: ProviderFormValues = {
    name: "",
    baseURL: "",
    apiKey: "",
    model: "",
  }
  let choice: ProviderChoice | null = null
  let stepIndex = 0
  // Set when the operator escapes the model pick-list into free text.
  let typedModel = false
  let submitting = false
  let submitPhase: SubmitPhase = "testing"
  let submitError: string | null = null
  let saveAnywayOffered = false
  let rampTimer: ReturnType<typeof setInterval> | null = null

  const startLogin = config.startLogin ?? defaultLoginStarter
  const loginTimeoutMs = config.loginTimeoutMs ?? LOGIN_TIMEOUT_MS
  let loginStatus: "idle" | "pending" | "failed" | "done" = "idle"
  let loginURL: string | null = null
  let loginError: string | null = null
  let loginResult: OAuthResult | null = null
  let loginAbort: AbortController | null = null
  let loginHandle: OAuthLoginStart | null = null
  let loginTimer: ReturnType<typeof setTimeout> | null = null
  // Carried back to the provider step so an abandoned sign-in says so there
  // rather than dropping the operator on a silent list.
  let loginCancelled = false
  // Bumped on every start and every abandon, so a late resolution from a
  // cancelled or superseded attempt can never move the screen.
  let loginAttempt = 0

  if (config.initialProviderId !== undefined) {
    const preselected = choices.find((c) => c.id === config.initialProviderId)
    if (preselected !== undefined) {
      choice = preselected
      stepIndex = 1
      values.name = preselected.label
      values.baseURL = preselected.baseURL
      values.model = preselected.defaultModel
    }
  }

  const margin = resolveSideMargin(renderer.width || 80)

  let listRows: readonly ResidualCatalogEntry[] = providerChoiceRows(choices)
  let list: ListViewportState = createListViewport({
    count: listRows.length,
    height: listHeight(),
  })

  function listHeight(): number {
    const rows = renderer.height || 24
    return Math.max(
      LIST_ROWS_MIN,
      Math.min(LIST_ROWS_MAX, rows - chromeBudget(CHROME_ROWS)),
    )
  }

  const steps = (): readonly SetupStep[] => stepsFor(choice)
  const currentStep = (): SetupStep =>
    steps()[stepIndex] ?? ("provider" as SetupStep)
  const isListStep = (): boolean => {
    const step = currentStep()
    if (step === "provider") return true
    return step === "model" && choice !== null && !choice.custom && !typedModel
  }

  const root = new BoxRenderable(renderer, {
    id: "provider-setup",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: UI.ground,
    paddingTop: 1,
    paddingLeft: margin,
    paddingRight: margin,
  })

  const header = new TextRenderable(renderer, {
    id: "provider-setup-header",
    content: `${PRODUCT_NAME.toLowerCase()} · setup`,
    fg: UI.inFlightBright,
  })
  const intro = new TextRenderable(renderer, {
    id: "provider-setup-welcome",
    content: "connect an inference provider — switch later with /model",
    fg: UI.textDim,
  })
  const step = new TextRenderable(renderer, {
    id: "provider-setup-step",
    content: "",
    fg: UI.action,
  })
  const instruction = new TextRenderable(renderer, {
    id: "provider-setup-instruction",
    content: "",
    fg: UI.text,
  })

  const summary = new BoxRenderable(renderer, {
    id: "provider-setup-summary",
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
    paddingTop: 1,
    backgroundColor: UI.ground,
  })
  const summarySlots = Array.from(
    { length: SUMMARY_SLOTS },
    (_, i) =>
      new TextRenderable(renderer, {
        id: `provider-setup-summary-${String(i)}`,
        content: "",
        fg: UI.textDim,
      }),
  )
  for (const row of summarySlots) summary.add(row)

  const listBox = new BoxRenderable(renderer, {
    id: "provider-setup-list",
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
    paddingTop: 1,
    backgroundColor: UI.ground,
  })
  const listSlots = Array.from(
    { length: LIST_ROWS_MAX },
    (_, i) =>
      new TextRenderable(renderer, {
        id: `provider-setup-list-${String(i)}`,
        content: "",
        fg: UI.textDim,
      }),
  )
  for (const row of listSlots) listBox.add(row)

  const inputFrame = new BoxRenderable(renderer, {
    id: "provider-setup-input-frame",
    width: "100%",
    height: 3,
    flexShrink: 0,
    border: true,
    borderColor: UI.textFaint,
    focusedBorderColor: UI.inFlight,
    backgroundColor: UI.ground,
    paddingLeft: 1,
    paddingRight: 1,
  })
  const input = new InputRenderable(renderer, {
    id: "provider-setup-input",
    width: "100%",
    maxLength: FIELD_MAX_LENGTH,
    placeholder: PROVIDER_FIELD_HINTS.apiKey,
    backgroundColor: UI.ground,
    focusedBackgroundColor: UI.ground,
    textColor: UI.text,
    cursorColor: UI.text,
    placeholderColor: UI.textFaint,
  })
  inputFrame.add(input)

  const loginBox = new BoxRenderable(renderer, {
    id: "provider-setup-login",
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
    paddingTop: 1,
    backgroundColor: UI.ground,
    visible: false,
  })
  const loginSlots = Array.from(
    { length: LOGIN_ROWS },
    (_, i) =>
      new TextRenderable(renderer, {
        id: `provider-setup-login-${String(i)}`,
        content: "",
        fg: UI.textDim,
      }),
  )
  for (const row of loginSlots) loginBox.add(row)

  const statusLine = new TextRenderable(renderer, {
    id: "provider-setup-status",
    content: "",
    fg: UI.textDim,
  })
  const guidance = new TextRenderable(renderer, {
    id: "provider-setup-guidance",
    content: "",
    fg: UI.textDim,
  })
  const telemetry = new BoxRenderable(renderer, {
    id: "provider-setup-telemetry",
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
    paddingTop: 1,
    backgroundColor: UI.ground,
    visible: config.showTelemetryNotice,
  })
  const telemetrySlots = Array.from(
    { length: TELEMETRY_ROWS },
    (_, i) =>
      new TextRenderable(renderer, {
        id: `provider-setup-telemetry-${String(i)}`,
        content: "",
        // A disclosure, not fine print: body emphasis, above the footer.
        fg: UI.text,
      }),
  )
  for (const row of telemetrySlots) telemetry.add(row)
  if (config.showTelemetryNotice) {
    const width = Math.max(20, (renderer.width || 80) - margin * 2)
    const lines = wrapLines(TELEMETRY_NOTICE, width).slice(0, TELEMETRY_ROWS)
    lines.forEach((line, i) => {
      const slot = telemetrySlots[i]
      if (slot !== undefined) slot.content = line
    })
  }

  const footer = new TextRenderable(renderer, {
    id: "provider-setup-footer",
    content: "",
    fg: UI.textFaint,
  })

  root.add(header)
  root.add(intro)
  root.add(step)
  root.add(instruction)
  root.add(summary)
  root.add(listBox)
  root.add(loginBox)
  root.add(inputFrame)
  root.add(statusLine)
  root.add(guidance)
  root.add(telemetry)
  root.add(footer)
  renderer.root.add(root)

  const paintSummary = (): void => {
    const rows = summaryRows(steps(), stepIndex, values, choice)
    summarySlots.forEach((slot, i) => {
      const row = rows[i]
      if (row === undefined) {
        slot.content = ""
        slot.visible = false
        return
      }
      slot.visible = true
      slot.content = summaryLine(row)
      slot.fg = summaryColor(row)
    })
  }

  const paintList = (): void => {
    const showList = isListStep() && !submitting
    listBox.visible = showList
    if (!showList) {
      for (const slot of listSlots) {
        slot.content = ""
        slot.visible = false
      }
      return
    }
    const slice = visibleSlice(list)
    listSlots.forEach((slot, i) => {
      const index = slice.start + i
      const row = index < slice.end ? listRows[index] : undefined
      if (row === undefined) {
        slot.content = ""
        slot.visible = false
        return
      }
      const active = index === slice.activeIndex
      slot.visible = true
      slot.content = ` ${active ? ">" : " "} ${row.label}`
      slot.fg = active ? UI.text : UI.textDim
    })
  }

  const isLoginStep = (): boolean => currentStep() === "login"

  const paintLogin = (): void => {
    const show = isLoginStep() && !submitting
    loginBox.visible = show
    const width = Math.max(20, (renderer.width || 80) - margin * 2)
    const lines: string[] =
      !show || loginURL === null
        ? []
        : ["open this url to authorize:", ...wrapLines(loginURL, width)]
    loginSlots.forEach((slot, i) => {
      const line = lines[i]
      if (line === undefined) {
        slot.content = ""
        slot.visible = false
        return
      }
      slot.visible = true
      slot.content = line
      // The url is the one thing to act on here, so it reads above chrome.
      slot.fg = i === 0 ? UI.textDim : UI.inFlightBright
    })
  }

  const paintStatus = (): void => {
    if (!submitting && isLoginStep()) {
      if (loginStatus === "failed") {
        const ramp = rampFor({ phase: "blocked", nowMs: 0 })
        statusLine.content = rampLine(ramp, (loginError ?? "").toLowerCase())
        statusLine.fg = ramp.fg
        guidance.content = loginGuidance()
        guidance.fg = UI.textDim
        return
      }
      if (loginStatus === "done") {
        const ramp = rampFor({ phase: "done", nowMs: 0 })
        statusLine.content = rampLine(
          ramp,
          `signed in as ${loginResult?.providerName ?? DEFAULT_OAUTH_PROFILE}`,
        )
        statusLine.fg = ramp.fg
        guidance.content = "enter to pick a model"
        guidance.fg = UI.textDim
        return
      }
      const ramp = rampFor({ phase: "working", nowMs: Date.now() })
      statusLine.content = rampLine(ramp, LOGIN_WAITING_LABEL)
      statusLine.fg = ramp.fg
      guidance.content = "the browser should have opened — paste the url if not"
      guidance.fg = UI.textDim
      return
    }
    if (!submitting && loginCancelled) {
      const ramp = rampFor({ phase: "blocked", nowMs: 0 })
      statusLine.content = rampLine(ramp, LOGIN_CANCELLED_MESSAGE)
      statusLine.fg = ramp.fg
      guidance.content = loginCancelGuidance()
      guidance.fg = UI.textDim
      return
    }
    if (submitting) {
      const ramp = rampFor({ phase: "working", nowMs: Date.now() })
      statusLine.content = rampLine(ramp, SUBMIT_PHASE_LABEL[submitPhase])
      statusLine.fg = ramp.fg
      guidance.content = ""
      return
    }
    if (submitError !== null) {
      const ramp = rampFor({ phase: "blocked", nowMs: 0 })
      statusLine.content = rampLine(ramp, submitError.toLowerCase())
      statusLine.fg = ramp.fg
      guidance.content = failureGuidance(submitPhase, choice)
      guidance.fg = UI.textDim
      return
    }
    statusLine.content = ""
    guidance.content = ""
  }

  const paintFooter = (): void => {
    if (submitting) {
      footer.content = "ctrl+c cancel"
      return
    }
    if (isLoginStep()) {
      footer.content =
        loginStatus === "failed"
          ? "enter retry · esc back · ctrl+c cancel"
          : loginStatus === "done"
            ? "enter continue · esc back · ctrl+c cancel"
            : "esc cancel sign-in · ctrl+c quit"
      return
    }
    footer.content = isListStep()
      ? "↑↓ move · enter choose · ctrl+c cancel"
      : stepIndex === 0
        ? "enter confirm · ctrl+c cancel"
        : "enter confirm · esc back · ctrl+c cancel"
  }

  const paint = (): void => {
    const active = currentStep()
    step.content = stepHeadline(steps(), stepIndex)
    instruction.content = STEP_PROMPTS[active]
    paintSummary()
    paintList()
    paintLogin()
    const showInput = !isListStep() && !isLoginStep() && !submitting
    inputFrame.visible = showInput
    input.visible = showInput
    paintStatus()
    paintFooter()
  }

  const showStep = (): void => {
    const active = currentStep()
    if (isListStep() || isLoginStep()) {
      input.blur()
      paint()
      // Arriving on the sign-in step is the trigger: there is nothing to type,
      // so the flow starts itself rather than waiting for a keystroke.
      if (isLoginStep() && loginStatus === "idle") beginLogin()
      return
    }
    const field = active as ProviderField
    input.placeholder = PROVIDER_FIELD_HINTS[field]
    input.value = field === "apiKey" ? maskEcho(values.apiKey) : values[field]
    // Paint first: focus is refused while the input is still hidden.
    paint()
    input.focus()
  }

  let settled = false
  let resolveDone: (submitted: boolean) => void = () => {}
  const done = new Promise<boolean>((resolve) => {
    resolveDone = resolve
  })

  const stopRamp = (): void => {
    if (rampTimer === null) return
    clearInterval(rampTimer)
    rampTimer = null
  }

  const teardown = (): void => {
    stopRamp()
    abandonLogin()
    renderer.keyInput.off("keypress", onKey)
    input.off(InputRenderableEvents.ENTER, onEnter)
    input.off(InputRenderableEvents.INPUT, onInput)
    try {
      renderer.root.remove(root)
      destroySubtree(root)
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

  const clearError = (): void => {
    submitError = null
    saveAnywayOffered = false
    loginCancelled = false
  }

  const clearLoginTimer = (): void => {
    if (loginTimer === null) return
    clearTimeout(loginTimer)
    loginTimer = null
  }

  /**
   * Drop whatever attempt is in flight: stop its deadline, close its callback
   * server, and bump the attempt counter so a late resolution is ignored.
   */
  const abandonLogin = (): void => {
    loginAttempt += 1
    clearLoginTimer()
    loginAbort?.abort()
    loginAbort = null
    loginHandle?.cancel()
    loginHandle = null
  }

  /** Denial, transport failure, or the deadline — all land the operator here. */
  const failLogin = (attempt: number, message: string): void => {
    if (attempt !== loginAttempt) return
    abandonLogin()
    stopRamp()
    loginStatus = "failed"
    loginError = message
    loginURL = null
    paint()
  }

  const finishLogin = (
    attempt: number,
    kind: OAuthKind,
    profile: string,
  ): void => {
    if (attempt !== loginAttempt) return
    clearLoginTimer()
    loginHandle = null
    loginAbort = null
    stopRamp()
    loginStatus = "done"
    loginError = null
    // The token is already on disk in the auth store; from here the surface
    // carries only the selection.
    const result = { kind, profile, providerName: oauthProviderName(kind, profile) }
    loginResult = result
    values.name = result.providerName
    values.apiKey = ""
    stepIndex += 1
    if (isListStep()) enterModelList()
    showStep()
  }

  const beginLogin = (): void => {
    const kind = choice?.oauth ?? null
    if (kind === null) return
    abandonLogin()
    const attempt = loginAttempt
    loginStatus = "pending"
    loginError = null
    loginURL = null
    loginCancelled = false
    const abort = new AbortController()
    loginAbort = abort
    // A browser round-trip that never comes back must still give the screen
    // back, so the deadline is armed before the flow is even started.
    loginTimer = setTimeout(() => {
      failLogin(attempt, LOGIN_TIMEOUT_MESSAGE)
    }, loginTimeoutMs)
    stopRamp()
    rampTimer = setInterval(paintStatus, RAMP_TICK_MS)
    paint()

    startLogin({ kind, profile: DEFAULT_OAUTH_PROFILE, signal: abort.signal }).then(
      (handle) => {
        if (attempt !== loginAttempt) {
          handle.cancel()
          return
        }
        loginHandle = handle
        loginURL = handle.authorizeUrl
        paint()
        handle.completed.then(
          (result) => {
            finishLogin(attempt, kind, result.profile)
          },
          (err: unknown) => {
            failLogin(attempt, err instanceof Error ? err.message : String(err))
          },
        )
      },
      (err: unknown) => {
        failLogin(attempt, err instanceof Error ? err.message : String(err))
      },
    )
  }

  /** Abandon an outstanding sign-in and return to the provider list. */
  const cancelLogin = (): void => {
    const wasPending = loginStatus === "pending"
    abandonLogin()
    stopRamp()
    loginStatus = "idle"
    loginURL = null
    loginError = null
    loginResult = null
    back()
    loginCancelled = wasPending
    paint()
  }

  const submit = (skipValidation: boolean): void => {
    submitting = true
    submitPhase = "testing"
    clearError()
    paint()
    stopRamp()
    rampTimer = setInterval(paintStatus, RAMP_TICK_MS)

    // Track the phase locally so the rejection handler knows whether the
    // failure happened during the connection test (retryable and bypassable)
    // or during the settings write.
    let phase: SubmitPhase = "testing"
    const setPhase = (p: SubmitPhase): void => {
      phase = p
      submitPhase = p
      paint()
    }

    const preset: ProviderPreset | undefined =
      choice !== null && !choice.custom
        ? {
            id: choice.id,
            models: choice.models,
            anthropic: choice.anthropic,
            opencodeGo: choice.opencodeGo,
          }
        : undefined

    config
      .onSubmit(values, setPhase, {
        skipValidation,
        ...(preset !== undefined ? { preset } : {}),
        ...(loginResult !== null ? { oauth: loginResult } : {}),
      })
      .then(
        () => settle(true),
        (err: unknown) => {
          stopRamp()
          submitting = false
          submitPhase = phase
          submitError = err instanceof Error ? err.message : String(err)
          saveAnywayOffered = phase === "testing"
          paint()
        },
      )
  }

  const chooseProvider = (id: string): void => {
    const picked = providerChoiceById(id)
    if (picked === undefined) return
    choice = picked
    typedModel = false
    if (picked.custom) {
      values.name = ""
      values.baseURL = ""
      values.model = ""
    } else {
      values.name = picked.id
      values.baseURL = picked.baseURL
      values.model = picked.defaultModel
    }
    stepIndex += 1
    if (isListStep()) enterModelList()
  }

  const enterModelList = (): void => {
    if (choice === null) return
    listRows = modelChoiceRows(choice)
    const active = Math.max(
      0,
      listRows.findIndex((row) => modelFromRowId(choice?.id ?? "", row.id) === values.model),
    )
    list = createListViewport({
      count: listRows.length,
      height: listHeight(),
      activeIndex: active,
    })
  }

  const enterProviderList = (): void => {
    listRows = providerChoiceRows(choices)
    const active = Math.max(
      0,
      listRows.findIndex((row) => row.id === choice?.id),
    )
    list = createListViewport({
      count: listRows.length,
      height: listHeight(),
      activeIndex: active,
    })
  }

  const acceptListRow = (): void => {
    const { itemIds } = residualListFromCatalog(listRows)
    const id = residualIdFromSelection({ index: list.activeIndex }, itemIds)
    if (id === undefined) return
    clearError()
    if (currentStep() === "provider") {
      chooseProvider(id)
      showStep()
      return
    }
    if (id === TYPE_MODEL_ID) {
      typedModel = true
      values.model = ""
      showStep()
      return
    }
    values.model = modelFromRowId(choice?.id ?? "", id)
    submit(false)
  }

  const advance = (): void => {
    if (isListStep()) {
      acceptListRow()
      return
    }
    if (isLoginStep()) {
      if (loginStatus === "done") {
        stepIndex += 1
        if (isListStep()) enterModelList()
        showStep()
        return
      }
      // A pending sign-in has nothing to confirm; a failed one retries.
      if (loginStatus !== "pending") beginLogin()
      return
    }
    const field = currentStep() as ProviderField
    if (!stepReady(field, values[field])) return

    if (stepIndex < steps().length - 1) {
      stepIndex += 1
      clearError()
      if (isListStep()) enterModelList()
      showStep()
      return
    }
    submit(false)
  }

  const back = (): void => {
    if (stepIndex === 0) return
    stepIndex -= 1
    clearError()
    if (currentStep() === "provider") enterProviderList()
    else if (isListStep()) enterModelList()
    showStep()
  }

  function onInput(next: string): void {
    if (submitting || isListStep()) return
    const field = currentStep() as ProviderField
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
      if (isLoginStep()) cancelLogin()
      else back()
      return
    }
    if (isLoginStep()) {
      if (key.name === "return" || key.name === "enter") {
        key.preventDefault()
        advance()
      }
      return
    }
    if (!isListStep()) return

    if (key.name === "up" || key.name === "k") {
      key.preventDefault()
      list = moveActive(list, -1)
      paint()
      return
    }
    if (key.name === "down" || key.name === "j") {
      key.preventDefault()
      list = moveActive(list, 1)
      paint()
      return
    }
    if (key.name === "return" || key.name === "enter") {
      key.preventDefault()
      advance()
    }
  }

  input.on(InputRenderableEvents.ENTER, onEnter)
  input.on(InputRenderableEvents.INPUT, onInput)
  renderer.keyInput.on("keypress", onKey)
  showStep()

  return done
}
