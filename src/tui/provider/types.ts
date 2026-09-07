/**
 * Contract types shared across the provider setup split: the form/submit
 * surface other modules (and tests) program against, plus the mutable state
 * bag `runProviderSetup` threads through the paint, login, and discovery
 * flows. Lives in its own leaf module because submit/connect must not import
 * setup (that would be a cycle), yet need the same contracts setup defines.
 */

import type { BoxRenderable, CliRenderer, InputRenderable } from "@opentui/core";

import type { FirstClassOAuthProvider } from "../../../packages/first-class-providers/src/index.js";
import type { CodexTokens } from "../../auth/codex/store.js";
import type { AuthProfile } from "../../auth/oauth/store.js";
import type { XaiTokens } from "../../auth/xai/store.js";
import type {
  discoverOllamaModels as discoverOllamaModelsRequest,
  OllamaDiscoveryState,
} from "../../provider/ollama.js";
import type { prefetchGoModels as prefetchGoModelsRequest } from "../../provider/opencode-go-models.js";
import type { ResidualCatalogEntry } from "../residuals.js";
import type { OverlayList } from "../shell/internals.js";
import type { SetupStep } from "./steps.js";

export type OAuthKind = FirstClassOAuthProvider;

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

// "testing" covers the connection-check call against the entered credentials;
// "saving" covers the settings write that follows once the test succeeds.
export type SubmitPhase = "testing" | "saving";

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

/** Fetches the names of already-authorized profiles for a provider kind. */
export type OAuthProfileLister = (kind: OAuthKind) => Promise<readonly string[]>;

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

/**
 * Mutable state shared by the setup surface and its extracted flows. The
 * fields are plain and reassigned in place because the original single-function
 * implementation closed over them; the object form is what lets the paint,
 * login, and discovery phases live in separate modules without changing the
 * update semantics.
 */
export interface SetupState {
  readonly config: ProviderSetupConfig;
  readonly renderer: CliRenderer;
  readonly externalRenderer: boolean;
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
  // Carried back to the provider step so an abandoned sign-in says so there
  // rather than dropping the operator on a silent list.
  loginCancelled: boolean;
  // Bumped on every start and every abandon, so a late resolution from a
  // cancelled or superseded attempt can never move the screen.
  loginAttempt: number;
  // The OAuth "name" step's own state: an inline error from the last
  // validation, and a pending re-authorize confirmation for a name that
  // collided with an existing profile. `confirmedSlug` is the exact slug the
  // confirmation applies to, so an edit to the field (which invalidates it)
  // is detected by comparison rather than a separate dirty flag.
  oauthProfileError: string | null;
  oauthProfileConfirmPending: boolean;
  confirmedSlug: string | null;
  // Bumped whenever the name step is (re-)entered, so a profile-list fetch
  // left over from a step the operator has since navigated away from can
  // never write into the wrong step's state.
  oauthNameAttempt: number;
  readonly discoverOllamaModels: typeof discoverOllamaModelsRequest;
  ollamaDiscovery: "idle" | "loading" | OllamaDiscoveryState;
  ollamaDiscoveryAttempt: number;
  ollamaDiscoveryAbort: AbortController | null;
  readonly prefetchGoModels: typeof prefetchGoModelsRequest;
  goPrefetchAttempt: number;
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
}
