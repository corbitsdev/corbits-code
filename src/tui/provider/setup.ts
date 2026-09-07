/**
 * First-run provider setup on OpenTUI: the `runProviderSetup` surface
 * assembly and step navigation.
 *
 * Selection first: the operator picks a known provider from the first-class
 * catalog (which prefills base URL and models), types only the API key, then
 * picks a model. "Custom" falls back to the full manual form for endpoints the
 * catalog does not know.
 *
 * The surface owns paint + input only; the caller owns the connection test and
 * the settings write via `onSubmit`. Painting lives in surface.ts, the browser
 * sign-in and account-name flows in oauth.ts, model discovery in discovery.ts.
 */

import {
  createCliRenderer,
  InputRenderableEvents,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";

import { isOAuthProviderScopeError } from "../../auth/oauth-scope-check.js";
import {
  discoverOllamaModels as discoverOllamaModelsRequest,
  isOllamaProviderId,
} from "../../provider/ollama.js";
import { prefetchGoModels as prefetchGoModelsRequest } from "../../provider/opencode-go-models.js";
import { resolveSideMargin } from "../geometry/margins.js";
import { residualIdFromSelection, residualListFromCatalog } from "../residuals.js";
import { createOverlayList } from "../shell/overlay-list.js";
import {
  chooseProviderRow,
  enterModelListRows,
  enterProviderRows,
  modelFromRowId,
  providerChoiceRows,
  providerChoices,
  TYPE_MODEL_ID,
} from "./choices.js";
import { createDiscoveryFlows } from "./discovery.js";
import { maskEcho, PROVIDER_FIELD_HINTS, secretFromMaskedEdit, stepReady } from "./form.js";
import {
  createAccountNameFlow,
  createLoginFlow,
  defaultLoginStarter,
  defaultProfileLister,
  LOGIN_TIMEOUT_MS,
} from "./oauth.js";
import {
  createSurface,
  providerListHeight,
  RAMP_TICK_MS,
  stopRamp,
  teardownSurface,
} from "./surface.js";
import { stepsFor, type ProviderField, type SetupStep } from "./steps.js";
import type {
  ProviderPreset,
  ProviderSetupConfig,
  SetupSelectors,
  SetupState,
  SubmitPhase,
} from "./types.js";

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
  const initialRows = providerChoiceRows(choices);
  const state: SetupState = {
    config,
    renderer,
    externalRenderer,
    choices,
    existingProviderNames: config.existingProviderNames ?? [],
    values: {
      name: "",
      baseURL: "",
      apiKey: "",
      model: "",
      oauthProfile: "",
    },
    margin: resolveSideMargin(renderer.width || 80),
    choice: null,
    stepIndex: 0,
    typedModel: false,
    submitting: false,
    submitPhase: "testing",
    submitError: null,
    saveAnywayOffered: false,
    rampTimer: null,
    startLogin: config.startLogin ?? defaultLoginStarter,
    listOAuthProfiles: config.listOAuthProfiles ?? defaultProfileLister,
    loginTimeoutMs: config.loginTimeoutMs ?? LOGIN_TIMEOUT_MS,
    loginStatus: "idle",
    loginURL: null,
    loginError: null,
    loginResult: null,
    loginAbort: null,
    loginHandle: null,
    loginTimer: null,
    loginCancelled: false,
    loginAttempt: 0,
    oauthProfileError: null,
    oauthProfileConfirmPending: false,
    confirmedSlug: null,
    oauthNameAttempt: 0,
    discoverOllamaModels: config.discoverOllamaModels ?? discoverOllamaModelsRequest,
    ollamaDiscovery: "idle",
    ollamaDiscoveryAttempt: 0,
    ollamaDiscoveryAbort: null,
    prefetchGoModels: config.prefetchGoModels ?? prefetchGoModelsRequest,
    goPrefetchAttempt: 0,
    listRows: initialRows,
    list: createOverlayList(renderer as CliRenderer, {
      count: initialRows.length,
      items: providerListHeight(renderer),
    }),
    settled: false,
    resolveDone: () => {},
  };

  if (config.initialProviderId !== undefined) {
    const preselected = state.choices.find((c) => c.id === config.initialProviderId);
    if (preselected !== undefined) {
      state.choice = preselected;
      state.stepIndex = 1;
      state.values.name = preselected.label;
      state.values.baseURL = preselected.baseURL;
      state.values.model = preselected.defaultModel;
    }
  }

  const steps = (): readonly SetupStep[] => stepsFor(state.choice);
  const currentStep = (): SetupStep => steps()[state.stepIndex] ?? ("provider" as SetupStep);
  const isOllamaModelStep = (): boolean =>
    currentStep() === "model" && state.choice !== null && isOllamaProviderId(state.choice.id);
  const isListStep = (): boolean => {
    const step = currentStep();
    if (step === "provider") return true;
    if (isOllamaModelStep()) {
      return typeof state.ollamaDiscovery === "object" && state.ollamaDiscovery.status === "models";
    }
    return step === "model" && state.choice !== null && !state.choice.custom && !state.typedModel;
  };
  // The "name" step means two different things depending on the path: a
  // free-text provider name (custom) or a multi-instance account slug (OAuth
  // and first-class API-key) with suggestion/collision machinery. Only the
  // latter needs this branch.
  const isAccountNameStep = (): boolean =>
    currentStep() === "name" && state.choice !== null && !state.choice.custom;
  const isGoModelListStep = (): boolean =>
    currentStep() === "model" &&
    state.choice !== null &&
    state.choice.opencodeGo &&
    !state.choice.custom &&
    !state.typedModel;
  const selectors: SetupSelectors = {
    steps,
    currentStep,
    isOllamaModelStep,
    isListStep,
    isAccountNameStep,
    isGoModelListStep,
  };
  const isLoginStep = (): boolean => currentStep() === "login";

  const surface = createSurface(state, selectors);
  const login = createLoginFlow(state, surface, selectors, { showStep, back, enterModelList });
  const discovery = createDiscoveryFlows(state, surface, selectors);
  const accountName = createAccountNameFlow(state, surface, { showStep, back, enterModelList });

  const done = new Promise<boolean>((resolve) => {
    state.resolveDone = resolve;
  });

  const teardown = (): void => {
    teardownSurface(state, surface, login, discovery, onKey, onEnter, onInput);
  };

  const settle = (submitted: boolean): void => {
    if (state.settled) return;
    state.settled = true;
    teardown();
    state.resolveDone(submitted);
  };

  const clearError = (): void => {
    state.submitError = null;
    state.saveAnywayOffered = false;
    state.loginCancelled = false;
  };

  function showStep(): void {
    const active = currentStep();
    if (isListStep() || isLoginStep() || isOllamaModelStep()) {
      surface.input.blur();
      surface.paint();
      if (isOllamaModelStep() && state.ollamaDiscovery === "idle") discovery.beginOllamaDiscovery();
      // Arriving on the sign-in step is the trigger: there is nothing to type,
      // so the flow starts itself rather than waiting for a keystroke.
      if (isLoginStep() && state.loginStatus === "idle") login.beginLogin();
      return;
    }
    if (isAccountNameStep()) {
      accountName.enter();
      return;
    }
    const field = active as ProviderField;
    surface.input.placeholder = PROVIDER_FIELD_HINTS[field];
    surface.input.value = field === "apiKey" ? maskEcho(state.values.apiKey) : state.values[field];
    // Paint first: focus is refused while the input is still hidden.
    surface.paint();
    surface.input.focus();
  }

  function submit(skipValidation: boolean): void {
    state.submitting = true;
    state.submitPhase = "testing";
    clearError();
    surface.paint();
    stopRamp(state);
    state.rampTimer = setInterval(() => surface.paintStatus(), RAMP_TICK_MS);

    // Track the phase locally so the rejection handler knows whether the
    // failure happened during the connection test (retryable and bypassable)
    // or during the settings write.
    let phase: SubmitPhase = "testing";
    const setPhase = (p: SubmitPhase): void => {
      phase = p;
      state.submitPhase = p;
      surface.paint();
    };

    const preset: ProviderPreset | undefined =
      state.choice !== null && !state.choice.custom
        ? {
            id: state.choice.id,
            models: state.choice.models,
            anthropic: state.choice.anthropic,
            opencodeGo: state.choice.opencodeGo,
          }
        : undefined;

    config
      .onSubmit(state.values, setPhase, {
        skipValidation,
        ...(preset !== undefined ? { preset } : {}),
        ...(state.loginResult !== null ? { oauth: state.loginResult } : {}),
      })
      .then(
        () => settle(true),
        (err: unknown) => {
          stopRamp(state);
          state.submitting = false;
          state.submitPhase = phase;
          state.submitError = err instanceof Error ? err.message : String(err);
          state.saveAnywayOffered = phase === "testing" && !isOAuthProviderScopeError(err);
          surface.paint();
        },
      );
  }

  const chooseProvider = (id: string): void => {
    chooseProviderRow(state, id, discovery);
    if (isListStep()) enterModelList();
  };

  function enterModelList(): void {
    enterModelListRows(state, renderer, discovery);
  }

  const enterProviderList = (): void => {
    enterProviderRows(state, renderer);
  };

  const acceptListRow = (): void => {
    const { itemIds } = residualListFromCatalog(state.listRows);
    const id = residualIdFromSelection({ index: state.list.activeIndex }, itemIds);
    if (id === undefined) return;
    clearError();
    if (currentStep() === "provider") {
      chooseProvider(id);
      showStep();
      return;
    }
    if (id === TYPE_MODEL_ID) {
      state.typedModel = true;
      state.values.model = "";
      showStep();
      return;
    }
    state.values.model = modelFromRowId(state.choice?.id ?? "", id);
    submit(false);
  };

  const advance = (): void => {
    if (isListStep()) {
      acceptListRow();
      return;
    }
    if (isOllamaModelStep()) {
      if (state.ollamaDiscovery !== "loading") discovery.beginOllamaDiscovery();
      return;
    }
    if (isLoginStep()) {
      if (state.loginStatus === "done") {
        state.stepIndex += 1;
        if (isListStep()) enterModelList();
        showStep();
        return;
      }
      // A pending sign-in has nothing to confirm; a failed one retries.
      if (state.loginStatus !== "pending") login.beginLogin();
      return;
    }
    if (isAccountNameStep()) {
      accountName.advance();
      return;
    }
    const field = currentStep() as ProviderField;
    if (!stepReady(field, state.values[field])) return;

    if (state.stepIndex < steps().length - 1) {
      state.stepIndex += 1;
      clearError();
      if (isListStep()) enterModelList();
      showStep();
      return;
    }
    submit(false);
  };

  function back(): void {
    if (state.stepIndex === 0) return;
    if (isOllamaModelStep()) {
      discovery.abandonOllamaDiscovery();
      state.ollamaDiscovery = "idle";
    }
    if (isGoModelListStep()) discovery.abandonGoPrefetch();
    state.stepIndex -= 1;
    clearError();
    if (currentStep() === "provider") enterProviderList();
    else if (isListStep()) enterModelList();
    showStep();
  }

  function onInput(next: string): void {
    if (state.submitting || isListStep()) return;
    if (isAccountNameStep()) {
      state.values.oauthProfile = next;
      // An edit invalidates whatever the last submit attempt found — the
      // confirm applies to one exact slug, and any inline error is stale
      // the moment the text it described changes.
      const hadFeedback = state.oauthProfileError !== null || state.oauthProfileConfirmPending;
      state.oauthProfileError = null;
      state.oauthProfileConfirmPending = false;
      state.confirmedSlug = null;
      if (hadFeedback) surface.paint();
      return;
    }
    const field = currentStep() as ProviderField;
    if (field === "apiKey") {
      state.values.apiKey = secretFromMaskedEdit(state.values.apiKey, next);
      const masked = maskEcho(state.values.apiKey);
      if (surface.input.value !== masked) surface.input.value = masked;
    } else {
      state.values[field] = next;
    }
    if (state.submitError !== null) {
      clearError();
      surface.paint();
    }
  }

  function onEnter(): void {
    if (state.submitting) return;
    advance();
  }

  function onKey(key: KeyEvent): void {
    if (state.settled) return;
    if (key.ctrl === true && (key.name === "c" || key.name === "d")) {
      key.preventDefault();
      settle(false);
      return;
    }
    if (state.submitting) {
      key.preventDefault();
      return;
    }
    if (key.ctrl === true && key.name === "s") {
      if (!state.saveAnywayOffered) return;
      key.preventDefault();
      submit(true);
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      if (isLoginStep()) {
        login.cancelLogin();
      } else if (isAccountNameStep() && state.oauthProfileConfirmPending) {
        // Cancel the re-authorize confirm without leaving the step — the
        // operator is about to edit the name, not abandon the provider.
        state.oauthProfileConfirmPending = false;
        state.confirmedSlug = null;
        surface.paint();
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
      state.list.move(-1);
      surface.paint();
      return;
    }
    if (key.name === "down" || key.name === "j") {
      key.preventDefault();
      state.list.move(1);
      surface.paint();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      key.preventDefault();
      advance();
    }
  }

  surface.input.on(InputRenderableEvents.ENTER, onEnter);
  surface.input.on(InputRenderableEvents.INPUT, onInput);
  renderer.keyInput.on("keypress", onKey);
  showStep();

  return done;
}
