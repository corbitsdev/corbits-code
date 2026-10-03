/**
 * Shared contracts for the provider setup split: the form/submit surface and
 * the mutable state bag `runProviderSetup` threads through its flows. Leaf
 * module so submit/connect can import these without importing setup.
 */

import type {
  BoxRenderable,
  CliRenderer,
  InputRenderable,
} from "@opentui/core";

import type { FirstClassOAuthProvider } from "../../../packages/first-class-providers/src/index.js";
import type { CodexTokens } from "../../auth/codex/store.js";
import type { AuthProfile } from "../../auth/store.js";
import type { MetaOAuthTokens } from "../../auth/meta/store.js";
import type { XaiTokens } from "../../auth/xai/store.js";
import type { ClipboardPort } from "../copy-path.js";
import type {
  discoverOllamaModels as discoverOllamaModelsRequest,
  OllamaDiscoveryState,
} from "../../provider/ollama.js";
import type {
  prefetchGoModels as prefetchGoModelsRequest,
  prefetchZenModels as prefetchZenModelsRequest,
} from "../../provider/model-catalogs.js";
import type { ResidualCatalogEntry } from "../residuals.js";
import type { OverlayList } from "../shell/internals.js";
import type { SetupStep } from "./steps.js";

export type OAuthKind = FirstClassOAuthProvider;

/**
 * A selectable provider. Preset rows carry everything the settings write needs
 * except the key; the custom row carries nothing and opens the manual form.
 */
export interface ProviderChoice {
  /** Catalog/settings kind this choice resolves to (e.g. "meta" for both Meta paths). */
  readonly id: string;
  /**
   * Pick-list row id. Defaults to `id`; a chooser whose paths both resolve to
   * the same catalog kind (Meta Sign In vs Meta API key, both `meta`) must
   * give the second row a distinct row id so it is reachable with arrows.
   */
  readonly rowId: string;
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

export interface ProviderFormValues {
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
  /**
   * Pre-login account slug for multi-instance paths (e.g. "personal"). Apart
   * from `name`, written once the account settles to carry the compound
   * catalog name (`codex/personal`); Custom still edits `name`.
   */
  oauthProfile: string;
  /** Explicit enabled levels; an empty custom set cannot be saved. */
  reasoningEfforts: string[];
  /** Operator-picked default effort level for new sessions ("" = none chosen). */
  defaultReasoningEffort: string;
  /** Custom-path sampling/token knobs; blank means unset, submit parses to numbers. */
  contextWindow: string;
  maxTokens: string;
  temperature: string;
  topP: string;
}

// "testing" = connection check; "saving" = the settings write that follows.
export type SubmitPhase = "testing" | "saving";

export interface OAuthResult {
  readonly kind: OAuthKind;
  readonly tokens: CodexTokens | XaiTokens | MetaOAuthTokens;
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

export interface SubmitOpts {
  // Save even if the connection test failed — /models is not universal.
  readonly skipValidation: boolean;
  /** Catalog metadata for the picked provider; absent on the custom path. */
  readonly preset?: ProviderPreset;
  /** Present when the operator exchanged OAuth credentials during setup. */
  readonly oauth?: OAuthResult;
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
    readonly profile: AuthProfile<CodexTokens | XaiTokens | MetaOAuthTokens>;
    readonly commit: () => Promise<void>;
  }>;
  readonly cancel: () => void;
}

export type OAuthLoginStarter = (input: {
  readonly kind: OAuthKind;
  readonly profile: string;
  readonly signal: AbortSignal;
  /** Device-flow only: called when the verification URI + user code are ready. */
  readonly notify?: (event: {
    readonly type: "device_code";
    readonly verificationUri: string;
    readonly userCode: string;
  }) => void;
}) => Promise<OAuthLoginStart>;

/** Fetches the names of already-authorized profiles for a provider kind. */
export type OAuthProfileLister = (
  kind: OAuthKind,
) => Promise<readonly string[]>;

export interface ProviderSetupConfig {
  readonly onSubmit: ProviderSetupSubmit;
  /** One-time telemetry disclosure, shown on the launch the first event fires. */
  readonly showTelemetryNotice: boolean;
  /** Renderer factory override for headless mounting in tests. */
  readonly createRenderer?: () => Promise<CliRenderer>;
  /**
   * Clipboard port for the Meta device flow. Defaults to a system clipboard
   * over the renderer (or a recording stub in tests).
   */
  readonly clipboard?: ClipboardPort;
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
  /** Zen catalog prefetch override so setup tests stay off the network. */
  readonly prefetchZenModels?: typeof prefetchZenModelsRequest;
  /** Start on the given provider's first form step, skipping the pick-list. */
  readonly initialProviderId?: string;
  /** Prefill the OAuth account-name step with the profile slug being re-keyed. */
  readonly initialOAuthProfile?: string;
  /** Existing catalog keys, for suggested slugs and collision confirms on the API-key path. */
  readonly existingProviderNames?: readonly string[];
}

/** Mutable state shared by the setup surface and its extracted flows. */
export interface SetupState {
  readonly config: ProviderSetupConfig;
  readonly renderer: CliRenderer;
  readonly externalRenderer: boolean;
  readonly clipboard: ClipboardPort;
  readonly choices: readonly ProviderChoice[];
  readonly existingProviderNames: readonly string[];
  readonly values: ProviderFormValues;
  readonly margin: number;
  choice: ProviderChoice | null;
  stepIndex: number;
  // Set when the operator escapes the model pick-list into free text.
  typedModel: boolean;
  submitting: boolean;
  submitPhase: SubmitPhase;
  submitError: string | null;
  saveAnywayOffered: boolean;
  rampTimer: ReturnType<typeof setInterval> | null;
  readonly startLogin: OAuthLoginStarter;
  readonly listOAuthProfiles: OAuthProfileLister;
  readonly loginTimeoutMs: number;
  loginStatus: "idle" | "pending" | "failed" | "done";
  loginURL: string | null;
  loginError: string | null;
  loginResult: OAuthResult | null;
  loginAbort: AbortController | null;
  loginHandle: OAuthLoginStart | null;
  loginTimer: ReturnType<typeof setTimeout> | null;
  // Lets the provider step report an abandoned sign-in instead of a silent list.
  /** Transient status flash (e.g. the Meta device-flow clipboard result). */
  statusFlash: string | null;
  statusFlashTimer: ReturnType<typeof setTimeout> | null;
  /** Device-flow code shown to the operator (Meta): verification URI + user code. */
  deviceCode: {
    verificationUri: string;
    userCode: string;
  } | null;
  // Carried back to the provider step so an abandoned sign-in says so there
  // rather than dropping the operator on a silent list.
  loginCancelled: boolean;
  // Bumped per start/abandon so a late resolution never moves the screen.
  loginAttempt: number;
  // OAuth name-step state: last validation error, a pending re-authorize
  // confirm for a colliding name, and the exact slug that confirm applies to
  // so an edit invalidates it by comparison.
  oauthProfileError: string | null;
  oauthProfileConfirmPending: boolean;
  confirmedSlug: string | null;
  // Bumped per name-step entry so a stale profile-list fetch cannot write into it.
  oauthNameAttempt: number;
  readonly discoverOllamaModels: typeof discoverOllamaModelsRequest;
  ollamaDiscovery: "idle" | "loading" | OllamaDiscoveryState;
  ollamaDiscoveryAttempt: number;
  ollamaDiscoveryAbort: AbortController | null;
  readonly prefetchGoModels: typeof prefetchGoModelsRequest;
  goPrefetchAttempt: number;
  readonly prefetchZenModels: typeof prefetchZenModelsRequest;
  zenPrefetchAttempt: number;
  listRows: readonly ResidualCatalogEntry[];
  list: OverlayList;
  settled: boolean;
  resolveDone: (submitted: boolean) => void;
}

/** Renderable tree plus the paint entry points the flows re-run on state change. */
export interface Surface {
  readonly root: BoxRenderable;
  readonly input: InputRenderable;
  paint(): void;
  paintStatus(): void;
}

export interface LoginFlow {
  /** Start (or restart) the browser sign-in for the current OAuth choice. */
  beginLogin(): void;
  /** Drop whatever sign-in attempt is in flight without moving the screen. */
  abandonLogin(): void;
  /** Abandon an outstanding sign-in and return to the provider list. */
  cancelLogin(): void;
}

export interface DiscoveryFlows {
  beginOllamaDiscovery(): void;
  abandonOllamaDiscovery(): void;
  beginGoPrefetch(): void;
  abandonGoPrefetch(): void;
  beginZenPrefetch(): void;
  abandonZenPrefetch(): void;
}

/** Multi-instance "name" step (OAuth accounts and API-key instances). */
export interface AccountNameFlow {
  /** Reset per-visit state and prefill a suggested, non-colliding slug. */
  enter(): void;
  /** Validate the typed slug; a collision needs one more Enter to confirm. */
  advance(): void;
}

/** Setup-surface step navigation the extracted flows call back into. */
export interface SetupFlowHooks {
  showStep(): void;
  back(): void;
  enterModelList(): void;
}

/** Step predicates the surface paint and the extracted flows share. */
export interface SetupSelectors {
  steps(): readonly SetupStep[];
  currentStep(): SetupStep;
  isOllamaModelStep(): boolean;
  isListStep(): boolean;
  isAccountNameStep(): boolean;
  isGoModelListStep(): boolean;
  isZenModelListStep(): boolean;
}
