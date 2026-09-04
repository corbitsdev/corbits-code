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
} from "@opentui/core";

import {
  FIRST_CLASS_PROVIDERS,
  firstClassPathAsProvider,
  type FirstClassOAuthProvider,
  type FirstClassProviderDef,
} from "../../packages/first-class-providers/src/index.js";
import { CODEX_BASE_URL, CODEX_DEFAULT_MODELS } from "../auth/codex/constants.js";
import { isOAuthProviderScopeError } from "../auth/oauth-scope-check.js";
import type { CodexTokens } from "../auth/codex/store.js";
import type { AuthProfile } from "../auth/oauth/store.js";
import { XAI_BASE_URL, XAI_DEFAULT_MODELS } from "../auth/xai/constants.js";
import type { XaiTokens } from "../auth/xai/store.js";
import { PRODUCT_NAME } from "../branding.js";
import {
  discoverOllamaModels as discoverOllamaModelsRequest,
  isOllamaProviderId,
  ollamaDiscoveryFailureLine,
  type OllamaDiscoveryState,
} from "../provider/ollama.js";
import {
  prefetchGoModels as prefetchGoModelsRequest,
  selectableGoModelIds,
} from "../provider/opencode-go-models.js";
import { codexProviderName } from "../config/codex-providers.js";
import { xaiProviderName } from "../config/xai-providers.js";
import { TELEMETRY_NOTICE } from "../telemetry/index.js";
import { wrapLines } from "./view/height.js";
import { resolveSideMargin } from "./geometry/margins.js";
import {
  createListViewport,
  moveActive,
  visibleSlice,
  type ListViewportState,
} from "./list-viewport.js";
import { buildModelsFirstCatalog } from "./model-catalog.js";
import { rampFor, rampLine } from "./ramp.js";
import {
  residualIdFromSelection,
  residualListFromCatalog,
  type ResidualCatalogEntry,
} from "./residuals.js";
import { destroySubtree } from "./teardown.js";
import { UI } from "./theme.js";

export type ProviderField = "name" | "baseURL" | "apiKey" | "model";

/** Placeholder shown in the text input for each free-text step. */
const PROVIDER_FIELD_HINTS: Record<ProviderField, string> = {
  name: "openai, anthropic, ollama, …",
  baseURL: "https://api.openai.com/v1",
  apiKey: "sk-… (blank for keyless/local)",
  model: "gpt-4o",
};

/** Placeholder for the OAuth account-name step, which edits `oauthProfile`. */
const OAUTH_PROFILE_HINT = "default, personal, work, …";

export interface ProviderFormValues {
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
  /**
   * Pre-login / pre-key account slug for multi-instance paths (e.g. "personal").
   * Kept apart from `name`, which is only written once the account is settled
   * and then carries the compound catalog name (`codex/personal`,
   * `openai/work`) — reusing it for the slug would make the field mean two
   * different things depending on where the operator is in the flow. Shared
   * by OAuth and first-class API-key multi-instance connects; Custom still
   * edits `name` free-form.
   */
  oauthProfile: string;
}

/** One screen of the flow. `provider` and `model` can be pick-lists. */
export type SetupStep = "provider" | "name" | "baseURL" | "apiKey" | "model" | "login";

/** Known-provider path: pick, name the instance, paste key, pick model. */
export const PRESET_STEPS: readonly SetupStep[] = ["provider", "name", "apiKey", "model"];

/** Ollama is keyless and keeps its editable root URL visible before discovery. */
export const OLLAMA_STEPS: readonly SetupStep[] = ["provider", "name", "baseURL", "model"];

/**
 * Subscription path: pick, name the account (a suggested slug is prefilled;
 * reusing an existing name asks for confirmation before re-authorizing it),
 * sign in through the browser, pick a model.
 */
export const OAUTH_STEPS: readonly SetupStep[] = ["provider", "name", "login", "model"];

/** Unknown endpoint: the full manual form, still preceded by the pick-list. */
export const CUSTOM_STEPS: readonly SetupStep[] = [
  "provider",
  "name",
  "baseURL",
  "apiKey",
  "model",
];

const STEP_LABELS: Record<SetupStep, string> = {
  provider: "provider",
  name: "provider name",
  baseURL: "base url",
  apiKey: "api key",
  model: "model",
  login: "sign in",
};

const STEP_PROMPTS: Record<SetupStep, string> = {
  provider: "pick the provider you have a key or subscription for",
  name: "name this provider — you will see it in /model",
  baseURL: "paste the provider url — Ollama uses the server root; others may include /v1",
  apiKey: "paste the api key — leave blank for a keyless local endpoint",
  model: "pick the model to start with",
  login: "authorize in the browser — this window waits for you",
};

/** Instruction for the multi-instance "name" step (OAuth and API-key). */
function accountNamePrompt(choice: ProviderChoice): string {
  if (choice.oauth != null) {
    return `name this account — stored as ${choice.oauth}/<name>, and used again if you reconnect it`;
  }
  return `name this instance — stored as ${choice.id}/<name>, and used again if you reconnect it`;
}

// "testing" covers the connection-check call against the entered credentials;
// "saving" covers the settings write that follows once the test succeeds.
export type SubmitPhase = "testing" | "saving";

const SUBMIT_PHASE_LABEL: Record<SubmitPhase, string> = {
  testing: "testing connection",
  saving: "writing settings",
};

/** Catalog id for the manual path. Never written to settings as a name. */
export const CUSTOM_CHOICE_ID = "custom";

/** Pick-list row that drops the model step back to free text. */
export const TYPE_MODEL_ID = "__type_model__";

/**
 * A selectable provider. Preset rows carry everything the settings write needs
 * except the key; the custom row carries nothing and opens the manual form.
 */
export interface ProviderChoice {
  readonly id: string;
  readonly label: string;
  readonly baseURL: string;
  readonly models: readonly string[];
  readonly defaultModel: string;
  readonly hint: string;
  /** Anthropic Messages protocol rather than OpenAI-compatible chat. */
  readonly anthropic: boolean;
  /** OpenCode Go subscription routing. */
  readonly opencodeGo: boolean;
  readonly custom: boolean;
  /** Browser sign-in flow to run instead of asking for a key. */
  readonly oauth: OAuthKind | null;
}

export type OAuthKind = FirstClassOAuthProvider;

/**
 * What a signed-in subscription provider resolves to. The endpoint and model
 * list are the same constants the auth stack projects into the catalog, so a
 * first run and a later `/model` connect land on the same provider entry.
 */
const OAUTH_SURFACES: Record<
  OAuthKind,
  {
    readonly baseURL: string;
    readonly models: readonly string[];
    readonly hint: string;
    readonly providerName: (profile: string) => string;
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
};

/** Settings/catalog provider name a profile of `kind` is stored under. */
export function oauthProviderName(kind: OAuthKind, profile: string): string {
  return OAUTH_SURFACES[kind].providerName(profile);
}

/** Longest slug the name step accepts, after normalization. */
const OAUTH_PROFILE_MAX_LENGTH = 64;

const OAUTH_PROFILE_CHARS = /^[a-z0-9._-]+$/;
const OAUTH_PROFILE_EDGE_SEPARATOR = /^[._-]|[._-]$/;

export type OAuthProfileValidation =
  { readonly ok: true; readonly slug: string } | { readonly ok: false; readonly error: string };

/**
 * Validate and lowercase-normalize an operator-entered account slug. This is
 * the constraint owner for the slug shape — the auth store and the catalog
 * projection (`oauthProviderName`) trust whatever they are handed, since a
 * "/" here would silently join into the compound catalog name they build.
 */
export function validateOAuthProfileSlug(raw: string): OAuthProfileValidation {
  const slug = raw.trim().toLowerCase();
  if (slug.length === 0) return { ok: false, error: "name cannot be empty" };
  if (slug.length > OAUTH_PROFILE_MAX_LENGTH) {
    return {
      ok: false,
      error: `name must be ${String(OAUTH_PROFILE_MAX_LENGTH)} characters or fewer`,
    };
  }
  if (!OAUTH_PROFILE_CHARS.test(slug)) {
    return { ok: false, error: "use only lowercase letters, numbers, and . _ -" };
  }
  if (OAUTH_PROFILE_EDGE_SEPARATOR.test(slug)) {
    return { ok: false, error: "name cannot start or end with . _ or -" };
  }
  return { ok: true, slug };
}

/**
 * A slug that does not collide with `existing`, so a first sign-in can
 * default to something usable without asking the operator to invent a name.
 * "default" first, then "default-2", "default-3", … on collision.
 */
export function suggestOAuthProfileSlug(existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has("default")) return "default";
  let n = 2;
  while (taken.has(`default-${String(n)}`)) n += 1;
  return `default-${String(n)}`;
}

/** Fetches the names of already-authorized profiles for a provider kind. */
export type OAuthProfileLister = (kind: OAuthKind) => Promise<readonly string[]>;

/**
 * Real lister, imported lazily per kind so mounting the surface never touches
 * the auth-store files in a test that injects its own lister.
 */
const defaultProfileLister: OAuthProfileLister = async (kind) => {
  if (kind === "codex") {
    const { listCodexProfiles } = await import("../auth/codex/store.js");
    return (await listCodexProfiles()).map((p) => p.name);
  }
  const { listXaiProfiles } = await import("../auth/xai/store.js");
  return (await listXaiProfiles()).map((p) => p.name);
};

function oauthChoice(id: string, label: string, kind: OAuthKind): ProviderChoice | null {
  const surface = OAUTH_SURFACES[kind];
  const defaultModel = surface.models[0];
  if (defaultModel === undefined) return null;
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
  };
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
};

function choiceFromDef(def: FirstClassProviderDef): ProviderChoice | null {
  if (def.auth !== "api-key" && def.auth !== "keyless") return null;
  if (def.baseURL === undefined || def.models === undefined) return null;
  const models = def.opencodeGo === true ? selectableGoModelIds() : def.models;
  const defaultModel = def.defaultModel ?? models[0];
  if (defaultModel === undefined) return null;
  return {
    id: def.id,
    label: def.label,
    baseURL: def.baseURL,
    models,
    defaultModel,
    hint: def.authHint ?? "",
    anthropic: def.anthropic === true,
    opencodeGo: def.opencodeGo === true,
    custom: false,
    oauth: null,
  };
}

/**
 * The pick-list, derived from the shared first-class catalog so onboarding and
 * `/model` connect never drift. Subscription providers are listed alongside the
 * key-based ones: their step is a browser sign-in rather than a paste, but a
 * first run must be able to start there.
 */
export function providerChoices(): readonly ProviderChoice[] {
  const out: ProviderChoice[] = [];
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
          );
          if (choice !== null) out.push(choice);
          continue;
        }
        if (path.auth !== "api-key") continue;
        const seeded = firstClassPathAsProvider(def, path.id);
        if (seeded === undefined) continue;
        const choice = choiceFromDef(seeded);
        if (choice !== null) out.push(choice);
      }
      continue;
    }
    if (def.auth === "oauth" && def.oauth !== undefined) {
      const choice = oauthChoice(def.id, def.label, def.oauth);
      if (choice !== null) out.push(choice);
      continue;
    }
    const choice = choiceFromDef(def);
    if (choice !== null) out.push(choice);
  }
  out.push(CUSTOM_CHOICE);
  return out;
}

export function providerChoiceById(id: string): ProviderChoice | undefined {
  return providerChoices().find((c) => c.id === id);
}

/**
 * How many connected accounts `choice` has in `providers`. Both OAuth and
 * first-class API-key kinds store instances as `kind/<slug>` (plus a legacy
 * bare `kind` key for the original single-instance connect), so prefix
 * matching is required. Custom is free-form and never counted here.
 */
export function connectedAccountCount(
  choice: ProviderChoice,
  providers: readonly { readonly name: string }[],
): number {
  if (choice.custom) return 0;
  const prefix = `${choice.id}/`;
  return providers.filter((p) => p.name === choice.id || p.name.startsWith(prefix)).length;
}

/**
 * Instance slugs already claimed for `kind` in the settings catalog. A legacy
 * bare `kind` key counts as the slug `"default"` so reconnecting the original
 * single-instance row still hits the confirm path.
 */
export function instanceSlugsForKind(
  kind: string,
  existingNames: readonly string[],
): readonly string[] {
  const prefix = `${kind}/`;
  const slugs: string[] = [];
  for (const name of existingNames) {
    if (name === kind) slugs.push("default");
    else if (name.startsWith(prefix)) {
      const slug = name.slice(prefix.length);
      if (slug.length > 0) slugs.push(slug);
    }
  }
  return slugs;
}

/**
 * Catalog key an API-key instance of `kind`/`slug` is stored under. Reuses a
 * legacy bare `kind` key when the slug is `"default"` and that bare key still
 * exists; otherwise always writes the compound form so siblings coexist.
 */
export function resolveApiKeyInstanceName(
  kind: string,
  slug: string,
  existingNames: readonly string[],
): string {
  const compound = `${kind}/${slug}`;
  if (existingNames.includes(compound)) return compound;
  if (slug === "default" && existingNames.includes(kind)) return kind;
  return compound;
}

/**
 * Rows for the model picker's Alt+A add-provider selector. Every first-class
 * kind is included, including Custom — filtering Custom out made free-form
 * endpoints unreachable from Alt+A even though onboarding still offered them.
 * Account counts use the same rules as the onboarding list.
 */
export function addProviderSelectorChoices(
  choices: readonly ProviderChoice[],
  providers: readonly { readonly name: string }[],
): readonly {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly accountCount: number;
}[] {
  return choices.map((choice) => ({
    id: choice.id,
    label: choice.label,
    hint: choice.hint,
    accountCount: connectedAccountCount(choice, providers),
  }));
}

/** Pick-list rows for the provider step. */
export function providerChoiceRows(
  choices: readonly ProviderChoice[] = providerChoices(),
): readonly ResidualCatalogEntry[] {
  return choices.map((c) => ({
    id: c.id,
    label: c.hint.length > 0 ? `${c.label} — ${c.hint}` : c.label,
  }));
}

/**
 * Pick-list rows for the model step, built from the shared models-first
 * catalog so the labels match the `/model` picker (including its cross-product
 * billing warnings). A trailing row escapes to free text for a model id the
 * seeded list does not carry yet.
 */
export function modelChoiceRows(choice: ProviderChoice): readonly ResidualCatalogEntry[] {
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
  });
  return [
    ...catalog.map((option) => ({
      id: option.id,
      label: option.label,
    })),
    { id: TYPE_MODEL_ID, label: "type a model id instead" },
  ];
}

/** `provider:model` → `model`, for a row id produced by the model catalog. */
export function modelFromRowId(providerId: string, rowId: string): string {
  const prefix = `${providerId}:`;
  return rowId.startsWith(prefix) ? rowId.slice(prefix.length) : rowId;
}

export function stepsFor(choice: ProviderChoice | null): readonly SetupStep[] {
  if (choice === null) return PRESET_STEPS;
  if (choice.custom) return CUSTOM_STEPS;
  if (isOllamaProviderId(choice.id)) return OLLAMA_STEPS;
  return choice.oauth !== null ? OAUTH_STEPS : PRESET_STEPS;
}

const MASK_CHAR = "●";
const MASK_CAP = 16;

/**
 * Bullet-render a secret for the read-only summary rows, capped so a long key
 * does not blow out the row width.
 */
export function maskSecret(value: string): string {
  return MASK_CHAR.repeat(Math.min([...value].length, MASK_CAP));
}

/**
 * Bullet-render a secret for the live input echo.
 *
 * Uncapped, unlike `maskSecret`: the echo is what `secretFromMaskedEdit` reads
 * back, so a capped echo would silently discard everything past the cap.
 */
export function maskEcho(value: string): string {
  return MASK_CHAR.repeat([...value].length);
}

/** apiKey is optional — blank means a keyless local provider (e.g. Ollama). */
export function stepReady(step: SetupStep, value: string): boolean {
  return step === "apiKey" || value.trim().length > 0;
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
  const chars = [...displayed];
  const typed = chars.filter((c) => c !== MASK_CHAR);
  const keptLength = chars.length - typed.length;
  return [...secret].slice(0, keptLength).join("") + typed.join("");
}

// The "name" step names a whole provider on the custom path but a single
// account/instance on multi-instance first-class kinds (OAuth and API-key).
function stepLabel(step: SetupStep, choice: ProviderChoice | null): string {
  if (step === "name" && choice !== null && !choice.custom) return "account name";
  return STEP_LABELS[step];
}

/** `step 2 of 4 · api key` — always says where the operator is and what is left. */
export function stepHeadline(
  steps: readonly SetupStep[],
  index: number,
  choice: ProviderChoice | null = null,
): string {
  const step = steps[Math.min(Math.max(index, 0), steps.length - 1)];
  if (step === undefined) return "";
  return `step ${index + 1} of ${steps.length} · ${stepLabel(step, choice)}`;
}

export interface SummaryRow {
  readonly label: string;
  readonly value: string;
  readonly state: "done" | "current" | "pending";
}

/** One row per step: settled rows show the value, later rows a dash. */
export function summaryRows(
  steps: readonly SetupStep[],
  index: number,
  values: ProviderFormValues,
  choice: ProviderChoice | null,
): readonly SummaryRow[] {
  return steps.map((step, i) => {
    const state = i < index ? "done" : i === index ? "current" : "pending";
    return {
      label: stepLabel(step, choice),
      value: state === "done" ? settledValue(step, values, choice) : "—",
      state,
    };
  });
}

function settledValue(
  step: SetupStep,
  values: ProviderFormValues,
  choice: ProviderChoice | null,
): string {
  if (step === "provider") return choice?.label ?? values.name;
  if (step === "login") return values.name.length > 0 ? values.name : "signed in";
  if (step === "apiKey") {
    return values.apiKey.length > 0 ? maskSecret(values.apiKey) : "keyless";
  }
  if (step === "name") {
    return choice !== null && !choice.custom ? values.oauthProfile : values.name;
  }
  if (step === "baseURL") return values.baseURL;
  return values.model;
}

/** Render a summary row at a fixed label column. */
export function summaryLine(row: SummaryRow): string {
  const marker = row.state === "current" ? "›" : " ";
  return `${marker} ${row.label.padEnd(14)}${row.state === "current" ? "" : row.value}`;
}

export function summaryColor(row: SummaryRow): string {
  if (row.state === "done") return UI.done;
  if (row.state === "current") return UI.text;
  return UI.textFaint;
}

/**
 * What the operator should do about a failure. A bare error message leaves a
 * first-run user stuck, so every failure names the field to fix.
 */
export function failureGuidance(
  phase: SubmitPhase,
  choice: ProviderChoice | null,
  offerSaveAnyway = true,
): string {
  if (phase === "saving") {
    return "settings could not be written — check disk permissions, enter to retry";
  }
  if (!offerSaveAnyway) {
    return choice !== null && !choice.custom
      ? "the account cannot be saved — esc to reconnect or enter to retry"
      : "check the base url and key — esc to go back, enter to retry";
  }
  return choice !== null && !choice.custom
    ? "the key was rejected or unreachable — esc to re-enter it, enter to retry, ctrl+s to save anyway"
    : "check the base url and key — esc to go back, enter to retry, ctrl+s to save anyway";
}

/** How long a sign-in may wait on the browser before it gives the screen back. */
export const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

export const LOGIN_TIMEOUT_MESSAGE = "sign-in timed out";

/** Set when the operator escapes a sign-in that was still outstanding. */
export const LOGIN_CANCELLED_MESSAGE = "sign-in cancelled";

/** What the operator should do about a sign-in that did not complete. */
export function loginGuidance(): string {
  return "enter to try signing in again · esc to pick a different provider";
}

/** What the operator should do after abandoning a sign-in. */
export function loginCancelGuidance(): string {
  return "nothing was saved — pick a provider to start over";
}

/** Status line while the browser round-trip is outstanding. */
export const LOGIN_WAITING_LABEL = "waiting for browser sign-in";

export interface SubmitOpts {
  // True when the operator chose to save despite a failed connection test —
  // some providers speak chat completions but not /models, so validation
  // cannot be a hard gate.
  readonly skipValidation: boolean;
  /**
   * Catalog metadata for the picked provider. Absent on the custom path. Lets
   * the caller persist the full seeded model list and the protocol flags the
   * four form values cannot express.
   */
  readonly preset?: ProviderPreset;
  /** Present when the operator exchanged OAuth credentials during setup. */
  readonly oauth?: OAuthResult;
}

export interface OAuthResult {
  readonly kind: OAuthKind;
  readonly tokens: CodexTokens | XaiTokens;
  readonly commit: () => Promise<void>;
  /** Settings/catalog name the stored profile projects to. */
  readonly providerName: string;
}

export interface ProviderPreset {
  readonly id: string;
  readonly models: readonly string[];
  readonly anthropic: boolean;
  readonly opencodeGo: boolean;
}

export type ProviderSetupSubmit = (
  values: ProviderFormValues,
  setPhase: (phase: SubmitPhase) => void,
  opts: SubmitOpts,
) => Promise<void>;

/** A login in flight: where to authorize, when it finished, how to abandon it. */
export interface OAuthLoginStart {
  readonly authorizeUrl: string;
  readonly completed: Promise<{
    readonly profile: AuthProfile<CodexTokens | XaiTokens>;
    readonly commit: () => Promise<void>;
  }>;
  readonly cancel: () => void;
}

export type OAuthLoginStarter = (input: {
  readonly kind: OAuthKind;
  readonly profile: string;
  readonly signal: AbortSignal;
}) => Promise<OAuthLoginStart>;

/**
 * Real login: PKCE plus a loopback callback server, per provider. Imported
 * lazily so mounting the surface never binds a port in a test that has
 * injected its own starter.
 */
const defaultLoginStarter: OAuthLoginStarter = async ({ kind, profile, signal }) => {
  if (kind === "codex") {
    const { startCodexLogin } = await import("../auth/codex/login.js");
    return startCodexLogin({ profile, signal });
  }
  const { startXaiLogin } = await import("../auth/xai/login.js");
  return startXaiLogin({ profile, signal });
};

export interface ProviderSetupConfig {
  readonly onSubmit: ProviderSetupSubmit;
  /**
   * One-time telemetry disclosure. Shown here so a brand-new install sees it
   * on the same launch the first telemetry event fires, not on a later run.
   */
  readonly showTelemetryNotice: boolean;
  /** Renderer factory override for headless mounting in tests. */
  readonly createRenderer?: () => Promise<CliRenderer>;
  /** Login driver override so tests need neither a browser nor a port. */
  readonly startLogin?: OAuthLoginStarter;
  /** Profile lister override so tests need no auth-store files on disk. */
  readonly listOAuthProfiles?: OAuthProfileLister;
  /** Sign-in deadline override, in milliseconds. */
  readonly loginTimeoutMs?: number;
  /** Ollama discovery override for deterministic setup tests. */
  readonly discoverOllamaModels?: typeof discoverOllamaModelsRequest;
  /** Go catalog prefetch override so setup tests stay off the network. */
  readonly prefetchGoModels?: typeof prefetchGoModelsRequest;
  /**
   * Skip the provider pick-list and start directly on that provider's first
   * form step (account name for multi-instance kinds, or the custom name
   * field) — the inline connect path from the model picker's add-provider
   * selector already knows which provider it wants.
   */
  readonly initialProviderId?: string;
  /**
   * Catalog keys already present in global settings. Used by the API-key
   * multi-instance name step for suggested slugs and collision confirms.
   * OAuth still reads live profiles from the auth store.
   */
  readonly existingProviderNames?: readonly string[];
}

const SUMMARY_SLOTS = CUSTOM_STEPS.length;
/** Wrapped rows reserved for the authorize URL and its instruction. */
const LOGIN_ROWS = 4;
// The whole first-class catalog plus the custom row fits without scrolling on a
// standard terminal: a first run should see every option it could pick.
const LIST_ROWS_MAX = 10;
const LIST_ROWS_MIN = 3;
const TELEMETRY_ROWS = 3;
/**
 * Input capacity. The renderable defaults to 1000 characters and truncates a
 * longer paste silently, which a first run would read as "paste is broken";
 * long-lived service-account keys and JWT-shaped tokens clear that default.
 */
const FIELD_MAX_LENGTH = 16_384;
/** Ramp animation tick. Fast enough to read as motion at 30fps paint. */
const RAMP_TICK_MS = 120;

/**
 * Mount the setup surface. Resolves true once `onSubmit` completes, false when
 * the operator cancels (Ctrl+C / Ctrl+D) without a successful submit.
 */
export async function runProviderSetup(config: ProviderSetupConfig): Promise<boolean> {
  // A caller-supplied renderer (a headless test harness, or a live session's
  // renderer reused for a mid-session reconnect) is owned by that caller —
  // teardown here must not destroy it out from under them.
  const externalRenderer = config.createRenderer !== undefined;
  const renderer = config.createRenderer
    ? await config.createRenderer()
    : await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
        // Reporting stays off during onboarding, unlike the main shell, so
        // the terminal owns drag-select and its own copy here.
        useMouse: false,
        enableMouseMovement: false,
      });

  const choices = providerChoices();
  const existingProviderNames = config.existingProviderNames ?? [];
  const values: ProviderFormValues = {
    name: "",
    baseURL: "",
    apiKey: "",
    model: "",
    oauthProfile: "",
  };
  let choice: ProviderChoice | null = null;
  let stepIndex = 0;
  // Set when the operator escapes the model pick-list into free text.
  let typedModel = false;
  let submitting = false;
  let submitPhase: SubmitPhase = "testing";
  let submitError: string | null = null;
  let saveAnywayOffered = false;
  let rampTimer: ReturnType<typeof setInterval> | null = null;

  const startLogin = config.startLogin ?? defaultLoginStarter;
  const listOAuthProfiles = config.listOAuthProfiles ?? defaultProfileLister;
  const loginTimeoutMs = config.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
  let loginStatus: "idle" | "pending" | "failed" | "done" = "idle";
  let loginURL: string | null = null;
  let loginError: string | null = null;
  let loginResult: OAuthResult | null = null;
  let loginAbort: AbortController | null = null;
  let loginHandle: OAuthLoginStart | null = null;
  let loginTimer: ReturnType<typeof setTimeout> | null = null;
  // Carried back to the provider step so an abandoned sign-in says so there
  // rather than dropping the operator on a silent list.
  let loginCancelled = false;
  // Bumped on every start and every abandon, so a late resolution from a
  // cancelled or superseded attempt can never move the screen.
  let loginAttempt = 0;

  // The OAuth "name" step's own state: an inline error from the last
  // validation, and a pending re-authorize confirmation for a name that
  // collided with an existing profile. `confirmedSlug` is the exact slug the
  // confirmation applies to, so an edit to the field (which invalidates it)
  // is detected by comparison rather than a separate dirty flag.
  let oauthProfileError: string | null = null;
  let oauthProfileConfirmPending = false;
  let confirmedSlug: string | null = null;
  // Bumped whenever the name step is (re-)entered, so a profile-list fetch
  // left over from a step the operator has since navigated away from can
  // never write into the wrong step's state.
  let oauthNameAttempt = 0;

  const discoverOllamaModels = config.discoverOllamaModels ?? discoverOllamaModelsRequest;
  let ollamaDiscovery: "idle" | "loading" | OllamaDiscoveryState = "idle";
  let ollamaDiscoveryAttempt = 0;
  let ollamaDiscoveryAbort: AbortController | null = null;

  const prefetchGoModels = config.prefetchGoModels ?? prefetchGoModelsRequest;
  let goPrefetchAttempt = 0;

  if (config.initialProviderId !== undefined) {
    const preselected = choices.find((c) => c.id === config.initialProviderId);
    if (preselected !== undefined) {
      choice = preselected;
      stepIndex = 1;
      values.name = preselected.label;
      values.baseURL = preselected.baseURL;
      values.model = preselected.defaultModel;
    }
  }

  const margin = resolveSideMargin(renderer.width || 80);

  let listRows: readonly ResidualCatalogEntry[] = providerChoiceRows(choices);
  let list: ListViewportState = createListViewport({
    count: listRows.length,
    height: listHeight(),
  });

  function listHeight(): number {
    // This budget is a guess, not a derivation: it runs before `root` is
    // even constructed below, so there has been no layout pass yet and
    // nothing in OpenTUI to measure — Renderable.height and scrollHeight
    // only reflect the last completed layout, populated post-mount. -14
    // is a hand count of the chrome rows above and below the list (header,
    // intro, step, instruction, summary, statusLine, guidance, footer, and
    // padding) with slack for a wrapped label; it goes stale if that chrome
    // changes and nothing here will catch it. A shared, derived chrome
    // budget for this and shell.ts's picker is tracked separately.
    const rows = renderer.height || 24;
    return Math.max(LIST_ROWS_MIN, Math.min(LIST_ROWS_MAX, rows - 14));
  }

  const steps = (): readonly SetupStep[] => stepsFor(choice);
  const currentStep = (): SetupStep => steps()[stepIndex] ?? ("provider" as SetupStep);
  const isOllamaModelStep = (): boolean =>
    currentStep() === "model" && choice !== null && isOllamaProviderId(choice.id);
  const isListStep = (): boolean => {
    const step = currentStep();
    if (step === "provider") return true;
    if (isOllamaModelStep()) {
      return typeof ollamaDiscovery === "object" && ollamaDiscovery.status === "models";
    }
    return step === "model" && choice !== null && !choice.custom && !typedModel;
  };
  // The "name" step means two different things depending on the path: a
  // free-text provider name (custom) or a multi-instance account slug (OAuth
  // and first-class API-key) with suggestion/collision machinery. Only the
  // latter needs this branch.
  const isAccountNameStep = (): boolean =>
    currentStep() === "name" && choice !== null && !choice.custom;

  const root = new BoxRenderable(renderer, {
    id: "provider-setup",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: UI.ground,
    paddingTop: 1,
    paddingLeft: margin,
    paddingRight: margin,
  });

  // Every direct child of `root` needs flexShrink: 0, full stop — a plain
  // TextRenderable defaults to shrinkable, and a short terminal makes the
  // flex algorithm compress unprotected single-line rows into each other
  // (garbled overlapping text) instead of clipping the column from the
  // bottom. header/intro/step/instruction here, and statusLine/guidance/
  // footer further down, all needed this; it is not specific to one step.
  const header = new TextRenderable(renderer, {
    id: "provider-setup-header",
    content: `${PRODUCT_NAME.toLowerCase()} · setup`,
    fg: UI.inFlightBright,
    flexShrink: 0,
  });
  const intro = new TextRenderable(renderer, {
    id: "provider-setup-welcome",
    content: "connect an inference provider — switch later with /model",
    fg: UI.textDim,
    flexShrink: 0,
  });
  const step = new TextRenderable(renderer, {
    id: "provider-setup-step",
    content: "",
    fg: UI.action,
    flexShrink: 0,
  });
  const instruction = new TextRenderable(renderer, {
    id: "provider-setup-instruction",
    content: "",
    fg: UI.text,
    flexShrink: 0,
  });

  const summary = new BoxRenderable(renderer, {
    id: "provider-setup-summary",
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
    paddingTop: 1,
    backgroundColor: UI.ground,
  });
  const summarySlots = Array.from(
    { length: SUMMARY_SLOTS },
    (_, i) =>
      new TextRenderable(renderer, {
        id: `provider-setup-summary-${String(i)}`,
        content: "",
        fg: UI.textDim,
      }),
  );
  for (const row of summarySlots) summary.add(row);

  const listBox = new BoxRenderable(renderer, {
    id: "provider-setup-list",
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
    paddingTop: 1,
    backgroundColor: UI.ground,
  });
  const listSlots = Array.from(
    { length: LIST_ROWS_MAX },
    (_, i) =>
      new TextRenderable(renderer, {
        id: `provider-setup-list-${String(i)}`,
        content: "",
        fg: UI.textDim,
      }),
  );
  for (const row of listSlots) listBox.add(row);

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
  });
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
  });
  inputFrame.add(input);

  const loginBox = new BoxRenderable(renderer, {
    id: "provider-setup-login",
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
    paddingTop: 1,
    backgroundColor: UI.ground,
    visible: false,
  });
  const loginSlots = Array.from(
    { length: LOGIN_ROWS },
    (_, i) =>
      new TextRenderable(renderer, {
        id: `provider-setup-login-${String(i)}`,
        content: "",
        fg: UI.textDim,
      }),
  );
  for (const row of loginSlots) loginBox.add(row);

  const statusLine = new TextRenderable(renderer, {
    id: "provider-setup-status",
    content: "",
    fg: UI.textDim,
    flexShrink: 0,
  });
  const guidance = new TextRenderable(renderer, {
    id: "provider-setup-guidance",
    content: "",
    fg: UI.textDim,
    flexShrink: 0,
  });
  const telemetry = new BoxRenderable(renderer, {
    id: "provider-setup-telemetry",
    width: "100%",
    flexDirection: "column",
    flexShrink: 0,
    paddingTop: 1,
    backgroundColor: UI.ground,
    visible: config.showTelemetryNotice,
  });
  const telemetrySlots = Array.from(
    { length: TELEMETRY_ROWS },
    (_, i) =>
      new TextRenderable(renderer, {
        id: `provider-setup-telemetry-${String(i)}`,
        content: "",
        // A disclosure, not fine print: body emphasis, above the footer.
        fg: UI.text,
      }),
  );
  for (const row of telemetrySlots) telemetry.add(row);
  if (config.showTelemetryNotice) {
    const width = Math.max(20, (renderer.width || 80) - margin * 2);
    const lines = wrapLines(TELEMETRY_NOTICE, width).slice(0, TELEMETRY_ROWS);
    lines.forEach((line, i) => {
      const slot = telemetrySlots[i];
      if (slot !== undefined) slot.content = line;
    });
  }

  const footer = new TextRenderable(renderer, {
    id: "provider-setup-footer",
    content: "",
    fg: UI.textFaint,
    flexShrink: 0,
  });

  root.add(header);
  root.add(intro);
  root.add(step);
  root.add(instruction);
  root.add(summary);
  root.add(listBox);
  root.add(loginBox);
  root.add(inputFrame);
  root.add(statusLine);
  root.add(guidance);
  root.add(telemetry);
  root.add(footer);
  renderer.root.add(root);

  const paintSummary = (): void => {
    const rows = summaryRows(steps(), stepIndex, values, choice);
    summarySlots.forEach((slot, i) => {
      const row = rows[i];
      if (row === undefined) {
        slot.content = "";
        slot.visible = false;
        return;
      }
      slot.visible = true;
      slot.content = summaryLine(row);
      slot.fg = summaryColor(row);
    });
  };

  const paintList = (): void => {
    const showList = isListStep() && !submitting;
    listBox.visible = showList;
    if (!showList) {
      for (const slot of listSlots) {
        slot.content = "";
        slot.visible = false;
      }
      return;
    }
    const slice = visibleSlice(list);
    listSlots.forEach((slot, i) => {
      const index = slice.start + i;
      const row = index < slice.end ? listRows[index] : undefined;
      if (row === undefined) {
        slot.content = "";
        slot.visible = false;
        return;
      }
      const active = index === slice.activeIndex;
      slot.visible = true;
      slot.content = ` ${active ? ">" : " "} ${row.label}`;
      slot.fg = active ? UI.text : UI.textDim;
    });
  };

  const isLoginStep = (): boolean => currentStep() === "login";

  const paintLogin = (): void => {
    const show = isLoginStep() && !submitting;
    loginBox.visible = show;
    const width = Math.max(20, (renderer.width || 80) - margin * 2);
    const lines: string[] =
      !show || loginURL === null
        ? []
        : ["open this url to authorize:", ...wrapLines(loginURL, width)];
    loginSlots.forEach((slot, i) => {
      const line = lines[i];
      if (line === undefined) {
        slot.content = "";
        slot.visible = false;
        return;
      }
      slot.visible = true;
      slot.content = line;
      // The url is the one thing to act on here, so it reads above chrome.
      slot.fg = i === 0 ? UI.textDim : UI.inFlightBright;
    });
  };

  const paintStatus = (): void => {
    if (!submitting && isOllamaModelStep() && ollamaDiscovery !== "idle") {
      if (ollamaDiscovery === "loading") {
        const ramp = rampFor({ phase: "working", nowMs: Date.now() });
        statusLine.content = rampLine(ramp, "checking installed Ollama models");
        statusLine.fg = ramp.fg;
        guidance.content = "esc to edit the Ollama URL";
        return;
      }
      if (ollamaDiscovery.status !== "models") {
        const empty = ollamaDiscovery.status === "empty";
        const malformed = ollamaDiscovery.status === "malformed";
        const ramp = rampFor({ phase: "blocked", nowMs: 0 });
        statusLine.content = rampLine(ramp, ollamaDiscoveryFailureLine(ollamaDiscovery));
        statusLine.fg = ramp.fg;
        guidance.content = empty
          ? "pull a model, then press enter to retry · esc to edit url"
          : malformed
            ? "check the Ollama URL, then press enter to retry · esc to edit url"
            : "press enter to retry · esc to edit url";
        return;
      }
    }
    if (!submitting && isAccountNameStep()) {
      if (oauthProfileError !== null) {
        const ramp = rampFor({ phase: "blocked", nowMs: 0 });
        statusLine.content = rampLine(ramp, oauthProfileError);
        statusLine.fg = ramp.fg;
        guidance.content = "fix the name and press enter";
        guidance.fg = UI.textDim;
        return;
      }
      if (oauthProfileConfirmPending) {
        const ramp = rampFor({ phase: "blocked", nowMs: 0 });
        statusLine.content = rampLine(
          ramp,
          `"${confirmedSlug ?? values.oauthProfile}" is already connected`,
        );
        statusLine.fg = ramp.fg;
        guidance.content =
          choice?.oauth != null
            ? "enter again to re-authorize this account · esc to cancel"
            : "enter again to replace this instance's key · esc to cancel";
        guidance.fg = UI.textDim;
        return;
      }
    }
    if (!submitting && isLoginStep()) {
      if (loginStatus === "failed") {
        const ramp = rampFor({ phase: "blocked", nowMs: 0 });
        statusLine.content = rampLine(ramp, (loginError ?? "").toLowerCase());
        statusLine.fg = ramp.fg;
        guidance.content = loginGuidance();
        guidance.fg = UI.textDim;
        return;
      }
      if (loginStatus === "done") {
        const ramp = rampFor({ phase: "done", nowMs: 0 });
        statusLine.content = rampLine(
          ramp,
          `signed in as ${loginResult?.providerName ?? "the account"}`,
        );
        statusLine.fg = ramp.fg;
        guidance.content = "enter to pick a model";
        guidance.fg = UI.textDim;
        return;
      }
      const ramp = rampFor({ phase: "working", nowMs: Date.now() });
      statusLine.content = rampLine(ramp, LOGIN_WAITING_LABEL);
      statusLine.fg = ramp.fg;
      guidance.content = "the browser should have opened — paste the url if not";
      guidance.fg = UI.textDim;
      return;
    }
    if (!submitting && loginCancelled) {
      const ramp = rampFor({ phase: "blocked", nowMs: 0 });
      statusLine.content = rampLine(ramp, LOGIN_CANCELLED_MESSAGE);
      statusLine.fg = ramp.fg;
      guidance.content = loginCancelGuidance();
      guidance.fg = UI.textDim;
      return;
    }
    if (submitting) {
      const ramp = rampFor({ phase: "working", nowMs: Date.now() });
      statusLine.content = rampLine(ramp, SUBMIT_PHASE_LABEL[submitPhase]);
      statusLine.fg = ramp.fg;
      guidance.content = "";
      return;
    }
    if (submitError !== null) {
      const ramp = rampFor({ phase: "blocked", nowMs: 0 });
      statusLine.content = rampLine(ramp, submitError.toLowerCase());
      statusLine.fg = ramp.fg;
      guidance.content = failureGuidance(submitPhase, choice, saveAnywayOffered);
      guidance.fg = UI.textDim;
      return;
    }
    statusLine.content = "";
    guidance.content = "";
  };

  const paintFooter = (): void => {
    if (submitting) {
      footer.content = "ctrl+c cancel";
      return;
    }
    if (isOllamaModelStep() && !isListStep()) {
      footer.content = "enter retry · esc edit url · ctrl+c cancel";
      return;
    }
    if (isLoginStep()) {
      footer.content =
        loginStatus === "failed"
          ? "enter retry · esc back · ctrl+c cancel"
          : loginStatus === "done"
            ? "enter continue · esc back · ctrl+c cancel"
            : "esc cancel sign-in · ctrl+c quit";
      return;
    }
    footer.content = isListStep()
      ? "↑↓ move · enter choose · ctrl+c cancel"
      : stepIndex === 0
        ? "enter confirm · ctrl+c cancel"
        : "enter confirm · esc back · ctrl+c cancel";
  };

  const paint = (): void => {
    const active = currentStep();
    step.content = stepHeadline(steps(), stepIndex, choice);
    instruction.content =
      isAccountNameStep() && choice !== null ? accountNamePrompt(choice) : STEP_PROMPTS[active];
    paintSummary();
    paintList();
    paintLogin();
    const showInput = !isListStep() && !isLoginStep() && !isOllamaModelStep() && !submitting;
    inputFrame.visible = showInput;
    input.visible = showInput;
    paintStatus();
    paintFooter();
  };

  const showStep = (): void => {
    const active = currentStep();
    if (isListStep() || isLoginStep() || isOllamaModelStep()) {
      input.blur();
      paint();
      if (isOllamaModelStep() && ollamaDiscovery === "idle") beginOllamaDiscovery();
      // Arriving on the sign-in step is the trigger: there is nothing to type,
      // so the flow starts itself rather than waiting for a keystroke.
      if (isLoginStep() && loginStatus === "idle") beginLogin();
      return;
    }
    if (isAccountNameStep()) {
      enterAccountNameStep();
      return;
    }
    const field = active as ProviderField;
    input.placeholder = PROVIDER_FIELD_HINTS[field];
    input.value = field === "apiKey" ? maskEcho(values.apiKey) : values[field];
    // Paint first: focus is refused while the input is still hidden.
    paint();
    input.focus();
  };

  /**
   * Enter the multi-instance "name" step: reset per-visit state, show whatever
   * slug is already typed, then resolve existing instance names to prefill a
   * suggested, non-colliding slug when the field is still blank. OAuth reads
   * the live auth store; API-key reads the settings catalog snapshot.
   */
  const enterAccountNameStep = (): void => {
    oauthProfileError = null;
    oauthProfileConfirmPending = false;
    input.placeholder = OAUTH_PROFILE_HINT;
    input.value = values.oauthProfile;
    paint();
    input.focus();
    if (choice === null || choice.custom) return;
    const attempt = (oauthNameAttempt += 1);
    const applySuggestion = (names: readonly string[]): void => {
      if (settled || attempt !== oauthNameAttempt) return;
      if (values.oauthProfile.trim().length === 0) {
        values.oauthProfile = suggestOAuthProfileSlug(names);
        input.value = values.oauthProfile;
        paint();
      }
    };
    if (choice.oauth !== null) {
      listOAuthProfiles(choice.oauth)
        .catch((): readonly string[] => [])
        .then(applySuggestion);
      return;
    }
    applySuggestion(instanceSlugsForKind(choice.id, existingProviderNames));
  };

  let settled = false;
  let resolveDone: (submitted: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => {
    resolveDone = resolve;
  });

  const stopRamp = (): void => {
    if (rampTimer === null) return;
    clearInterval(rampTimer);
    rampTimer = null;
  };

  const abandonOllamaDiscovery = (): void => {
    ollamaDiscoveryAttempt += 1;
    ollamaDiscoveryAbort?.abort();
    ollamaDiscoveryAbort = null;
  };

  const abandonGoPrefetch = (): void => {
    goPrefetchAttempt += 1;
  };

  const teardown = (): void => {
    stopRamp();
    abandonLogin();
    abandonOllamaDiscovery();
    abandonGoPrefetch();
    renderer.keyInput.off("keypress", onKey);
    input.off(InputRenderableEvents.ENTER, onEnter);
    input.off(InputRenderableEvents.INPUT, onInput);
    try {
      renderer.root.remove(root);
      destroySubtree(root);
    } catch {
      // already unmounted
    }
    if (!externalRenderer) {
      try {
        renderer.destroy();
      } catch {
        // already destroyed
      }
    }
  };

  const settle = (submitted: boolean): void => {
    if (settled) return;
    settled = true;
    teardown();
    resolveDone(submitted);
  };

  const clearError = (): void => {
    submitError = null;
    saveAnywayOffered = false;
    loginCancelled = false;
  };

  const clearLoginTimer = (): void => {
    if (loginTimer === null) return;
    clearTimeout(loginTimer);
    loginTimer = null;
  };

  /**
   * Drop whatever attempt is in flight: stop its deadline, close its callback
   * server, and bump the attempt counter so a late resolution is ignored.
   */
  const abandonLogin = (): void => {
    loginAttempt += 1;
    clearLoginTimer();
    loginAbort?.abort();
    loginAbort = null;
    loginHandle?.cancel();
    loginHandle = null;
  };

  /** Denial, transport failure, or the deadline — all land the operator here. */
  const failLogin = (attempt: number, message: string): void => {
    if (attempt !== loginAttempt) return;
    abandonLogin();
    stopRamp();
    loginStatus = "failed";
    loginError = message;
    loginURL = null;
    paint();
  };

  const finishLogin = (
    attempt: number,
    kind: OAuthKind,
    staged: Awaited<OAuthLoginStart["completed"]>,
  ): void => {
    if (attempt !== loginAttempt) return;
    clearLoginTimer();
    loginHandle = null;
    loginAbort = null;
    stopRamp();
    loginStatus = "done";
    loginError = null;
    const result: OAuthResult = {
      kind,
      tokens: staged.profile.tokens,
      commit: staged.commit,
      providerName: oauthProviderName(kind, staged.profile.name),
    };
    loginResult = result;
    values.name = result.providerName;
    values.apiKey = "";
    stepIndex += 1;
    if (isListStep()) enterModelList();
    showStep();
  };

  const beginLogin = (): void => {
    const kind = choice?.oauth ?? null;
    if (kind === null) return;
    abandonLogin();
    const attempt = loginAttempt;
    loginStatus = "pending";
    loginError = null;
    loginURL = null;
    loginCancelled = false;
    const abort = new AbortController();
    loginAbort = abort;
    // A browser round-trip that never comes back must still give the screen
    // back, so the deadline is armed before the flow is even started.
    loginTimer = setTimeout(() => {
      failLogin(attempt, LOGIN_TIMEOUT_MESSAGE);
    }, loginTimeoutMs);
    stopRamp();
    rampTimer = setInterval(paintStatus, RAMP_TICK_MS);
    paint();

    startLogin({ kind, profile: values.oauthProfile, signal: abort.signal }).then(
      (handle) => {
        if (attempt !== loginAttempt) {
          handle.cancel();
          return;
        }
        loginHandle = handle;
        loginURL = handle.authorizeUrl;
        paint();
        handle.completed.then(
          (result) => {
            finishLogin(attempt, kind, result);
          },
          (err: unknown) => {
            failLogin(attempt, err instanceof Error ? err.message : String(err));
          },
        );
      },
      (err: unknown) => {
        failLogin(attempt, err instanceof Error ? err.message : String(err));
      },
    );
  };

  /** Abandon an outstanding sign-in and return to the provider list. */
  const cancelLogin = (): void => {
    const wasPending = loginStatus === "pending";
    abandonLogin();
    stopRamp();
    loginStatus = "idle";
    loginURL = null;
    loginError = null;
    loginResult = null;
    back();
    loginCancelled = wasPending;
    paint();
  };

  const beginOllamaDiscovery = (): void => {
    if (!isOllamaModelStep()) return;
    abandonOllamaDiscovery();
    const attempt = ollamaDiscoveryAttempt;
    const rootURL = values.baseURL;
    const abort = new AbortController();
    ollamaDiscoveryAbort = abort;
    ollamaDiscovery = "loading";
    stopRamp();
    rampTimer = setInterval(paintStatus, RAMP_TICK_MS);
    paint();
    discoverOllamaModels({ rootURL, signal: abort.signal }).then(
      (result) => {
        if (
          settled ||
          attempt !== ollamaDiscoveryAttempt ||
          values.baseURL !== rootURL ||
          !isOllamaModelStep()
        ) {
          return;
        }
        stopRamp();
        ollamaDiscoveryAbort = null;
        ollamaDiscovery = result;
        if (result.status === "models" && choice !== null) {
          values.model = result.models[0] ?? "";
          // Seed the catalog choice so submit persists every installed model,
          // not only the one picked on this screen.
          choice = { ...choice, models: [...result.models], defaultModel: values.model };
          listRows = modelChoiceRows(choice).filter((row) => row.id !== TYPE_MODEL_ID);
          list = createListViewport({ count: listRows.length, height: listHeight() });
        }
        paint();
      },
      (err: unknown) => {
        if (
          settled ||
          attempt !== ollamaDiscoveryAttempt ||
          values.baseURL !== rootURL ||
          !isOllamaModelStep()
        ) {
          return;
        }
        stopRamp();
        ollamaDiscoveryAbort = null;
        ollamaDiscovery = {
          status: "malformed",
          message: err instanceof Error ? err.message : String(err),
        };
        paint();
      },
    );
  };

  const isGoModelListStep = (): boolean =>
    currentStep() === "model" &&
    choice !== null &&
    choice.opencodeGo &&
    !choice.custom &&
    !typedModel;

  const beginGoPrefetch = (): void => {
    if (!isGoModelListStep()) return;
    abandonGoPrefetch();
    const attempt = goPrefetchAttempt;
    void prefetchGoModels()
      .then((ids) => {
        if (settled || attempt !== goPrefetchAttempt || !isGoModelListStep() || choice === null) {
          return;
        }
        const listed = choice.models;
        const same = ids.length === listed.length && ids.every((id, i) => id === listed[i]);
        if (same) return;
        const focusedId = listRows[list.activeIndex]?.id;
        choice = { ...choice, models: [...ids] };
        listRows = modelChoiceRows(choice);
        const found =
          focusedId === undefined ? -1 : listRows.findIndex((row) => row.id === focusedId);
        list = createListViewport({
          count: listRows.length,
          height: listHeight(),
          activeIndex: found >= 0 ? found : 0,
        });
        paint();
      })
      .catch(() => {
        // Seed list is already on screen; a failed prefetch must not surface.
      });
  };

  const submit = (skipValidation: boolean): void => {
    submitting = true;
    submitPhase = "testing";
    clearError();
    paint();
    stopRamp();
    rampTimer = setInterval(paintStatus, RAMP_TICK_MS);

    // Track the phase locally so the rejection handler knows whether the
    // failure happened during the connection test (retryable and bypassable)
    // or during the settings write.
    let phase: SubmitPhase = "testing";
    const setPhase = (p: SubmitPhase): void => {
      phase = p;
      submitPhase = p;
      paint();
    };

    const preset: ProviderPreset | undefined =
      choice !== null && !choice.custom
        ? {
            id: choice.id,
            models: choice.models,
            anthropic: choice.anthropic,
            opencodeGo: choice.opencodeGo,
          }
        : undefined;

    config
      .onSubmit(values, setPhase, {
        skipValidation,
        ...(preset !== undefined ? { preset } : {}),
        ...(loginResult !== null ? { oauth: loginResult } : {}),
      })
      .then(
        () => settle(true),
        (err: unknown) => {
          stopRamp();
          submitting = false;
          submitPhase = phase;
          submitError = err instanceof Error ? err.message : String(err);
          saveAnywayOffered = phase === "testing" && !isOAuthProviderScopeError(err);
          paint();
        },
      );
  };

  const chooseProvider = (id: string): void => {
    const picked = providerChoiceById(id);
    if (picked === undefined) return;
    abandonOllamaDiscovery();
    ollamaDiscovery = "idle";
    choice = picked;
    values.apiKey = "";
    typedModel = false;
    oauthProfileError = null;
    oauthProfileConfirmPending = false;
    confirmedSlug = null;
    if (picked.custom) {
      values.name = "";
      values.baseURL = "";
      values.model = "";
    } else {
      // Multi-instance first-class kinds (OAuth and API-key): leave the catalog
      // name blank until the account/instance slug is settled. See the
      // `oauthProfile` doc comment on `ProviderFormValues`.
      values.name = "";
      values.baseURL = picked.baseURL;
      values.model = picked.defaultModel;
      values.oauthProfile = "";
    }
    stepIndex += 1;
    if (isListStep()) enterModelList();
  };

  const enterModelList = (): void => {
    if (choice === null) return;
    listRows = modelChoiceRows(choice);
    const active = Math.max(
      0,
      listRows.findIndex((row) => modelFromRowId(choice?.id ?? "", row.id) === values.model),
    );
    list = createListViewport({
      count: listRows.length,
      height: listHeight(),
      activeIndex: active,
    });
    beginGoPrefetch();
  };

  const enterProviderList = (): void => {
    listRows = providerChoiceRows(choices);
    const active = Math.max(
      0,
      listRows.findIndex((row) => row.id === choice?.id),
    );
    list = createListViewport({
      count: listRows.length,
      height: listHeight(),
      activeIndex: active,
    });
  };

  const acceptListRow = (): void => {
    const { itemIds } = residualListFromCatalog(listRows);
    const id = residualIdFromSelection({ index: list.activeIndex }, itemIds);
    if (id === undefined) return;
    clearError();
    if (currentStep() === "provider") {
      chooseProvider(id);
      showStep();
      return;
    }
    if (id === TYPE_MODEL_ID) {
      typedModel = true;
      values.model = "";
      showStep();
      return;
    }
    values.model = modelFromRowId(choice?.id ?? "", id);
    submit(false);
  };

  const advance = (): void => {
    if (isListStep()) {
      acceptListRow();
      return;
    }
    if (isOllamaModelStep()) {
      if (ollamaDiscovery !== "loading") beginOllamaDiscovery();
      return;
    }
    if (isLoginStep()) {
      if (loginStatus === "done") {
        stepIndex += 1;
        if (isListStep()) enterModelList();
        showStep();
        return;
      }
      // A pending sign-in has nothing to confirm; a failed one retries.
      if (loginStatus !== "pending") beginLogin();
      return;
    }
    if (isAccountNameStep()) {
      advanceAccountNameStep();
      return;
    }
    const field = currentStep() as ProviderField;
    if (!stepReady(field, values[field])) return;

    if (stepIndex < steps().length - 1) {
      stepIndex += 1;
      clearError();
      if (isListStep()) enterModelList();
      showStep();
      return;
    }
    submit(false);
  };

  /**
   * Validate the entered slug, then check collisions against a fresh source
   * (auth store for OAuth, settings catalog for API-key). A collision needs
   * one more Enter to confirm before the step advances.
   */
  const advanceAccountNameStep = (): void => {
    if (choice === null || choice.custom) return;
    const validated = validateOAuthProfileSlug(values.oauthProfile);
    if (!validated.ok) {
      oauthProfileError = validated.error;
      oauthProfileConfirmPending = false;
      confirmedSlug = null;
      paint();
      return;
    }
    const slug = validated.slug;
    // Already confirmed this exact slug on the previous Enter — proceed
    // without another round-trip. Any edit since then cleared the flag (see
    // onInput), so this only fires on a genuine second, unmodified Enter.
    if (oauthProfileConfirmPending && confirmedSlug === slug) {
      settleAccountNameSlug(slug);
      return;
    }
    const attempt = (oauthNameAttempt += 1);
    const handleNames = (names: readonly string[]): void => {
      if (settled || attempt !== oauthNameAttempt) return;
      if (names.includes(slug)) {
        oauthProfileError = null;
        oauthProfileConfirmPending = true;
        confirmedSlug = slug;
        paint();
        return;
      }
      settleAccountNameSlug(slug);
    };
    if (choice.oauth !== null) {
      listOAuthProfiles(choice.oauth)
        .catch((): readonly string[] => [])
        .then(handleNames);
      return;
    }
    handleNames(instanceSlugsForKind(choice.id, existingProviderNames));
  };

  const settleAccountNameSlug = (slug: string): void => {
    values.oauthProfile = slug;
    oauthProfileError = null;
    oauthProfileConfirmPending = false;
    confirmedSlug = null;
    if (choice !== null && choice.oauth === null && !choice.custom) {
      // API-key multi-instance: catalog key is kind/slug (or legacy bare kind
      // when reconnecting the original single-instance "default").
      values.name = resolveApiKeyInstanceName(choice.id, slug, existingProviderNames);
    }
    stepIndex += 1;
    showStep();
  };

  const back = (): void => {
    if (stepIndex === 0) return;
    if (isOllamaModelStep()) {
      abandonOllamaDiscovery();
      ollamaDiscovery = "idle";
    }
    if (isGoModelListStep()) abandonGoPrefetch();
    stepIndex -= 1;
    clearError();
    if (currentStep() === "provider") enterProviderList();
    else if (isListStep()) enterModelList();
    showStep();
  };

  function onInput(next: string): void {
    if (submitting || isListStep()) return;
    if (isAccountNameStep()) {
      values.oauthProfile = next;
      // An edit invalidates whatever the last submit attempt found — the
      // confirm applies to one exact slug, and any inline error is stale
      // the moment the text it described changes.
      const hadFeedback = oauthProfileError !== null || oauthProfileConfirmPending;
      oauthProfileError = null;
      oauthProfileConfirmPending = false;
      confirmedSlug = null;
      if (hadFeedback) paint();
      return;
    }
    const field = currentStep() as ProviderField;
    if (field === "apiKey") {
      values.apiKey = secretFromMaskedEdit(values.apiKey, next);
      const masked = maskEcho(values.apiKey);
      if (input.value !== masked) input.value = masked;
    } else {
      values[field] = next;
    }
    if (submitError !== null) {
      clearError();
      paint();
    }
  }

  function onEnter(): void {
    if (submitting) return;
    advance();
  }

  function onKey(key: KeyEvent): void {
    if (settled) return;
    if (key.ctrl === true && (key.name === "c" || key.name === "d")) {
      key.preventDefault();
      settle(false);
      return;
    }
    if (submitting) {
      key.preventDefault();
      return;
    }
    if (key.ctrl === true && key.name === "s") {
      if (!saveAnywayOffered) return;
      key.preventDefault();
      submit(true);
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      if (isLoginStep()) {
        cancelLogin();
      } else if (isAccountNameStep() && oauthProfileConfirmPending) {
        // Cancel the re-authorize confirm without leaving the step — the
        // operator is about to edit the name, not abandon the provider.
        oauthProfileConfirmPending = false;
        confirmedSlug = null;
        paint();
      } else {
        back();
      }
      return;
    }
    if (isLoginStep()) {
      if (key.name === "return" || key.name === "enter") {
        key.preventDefault();
        advance();
      }
      return;
    }
    if (isOllamaModelStep() && !isListStep() && (key.name === "return" || key.name === "enter")) {
      key.preventDefault();
      advance();
      return;
    }
    if (!isListStep()) return;

    if (key.name === "up" || key.name === "k") {
      key.preventDefault();
      list = moveActive(list, -1);
      paint();
      return;
    }
    if (key.name === "down" || key.name === "j") {
      key.preventDefault();
      list = moveActive(list, 1);
      paint();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      key.preventDefault();
      advance();
    }
  }

  input.on(InputRenderableEvents.ENTER, onEnter);
  input.on(InputRenderableEvents.INPUT, onInput);
  renderer.keyInput.on("keypress", onKey);
  showStep();

  return done;
}
