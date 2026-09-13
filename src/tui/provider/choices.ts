/**
 * Catalog projection: turns the shared first-class provider catalog (plus the
 * subscription surfaces and the manual Custom row) into pick-list choices, so
 * onboarding and `/model` connect never drift.
 */

import {
  FIRST_CLASS_PROVIDERS,
  firstClassPathAsProvider,
  type FirstClassProviderDef,
} from "../../../packages/first-class-providers/src/index.js";
import {
  CODEX_BASE_URL,
  CODEX_DEFAULT_MODELS,
} from "../../auth/codex/constants.js";
import { XAI_BASE_URL, XAI_DEFAULT_MODELS } from "../../auth/xai/constants.js";
import { codexProviderName } from "../../config/codex-providers.js";
import { xaiProviderName } from "../../config/xai-providers.js";
import { selectableGoModelIds } from "../../provider/opencode-go-models.js";
import { selectableZenModelIds } from "../../provider/zen-models.js";
import { isZenProviderId } from "../../../packages/zen/src/index.js";
import { buildModelsFirstCatalog } from "../model-catalog.js";
import type { ResidualCatalogEntry } from "../residuals.js";
import type { CliRenderer } from "@opentui/core";
import { createOverlayList } from "../shell/overlay-list.js";
import type {
  DiscoveryFlows,
  OAuthKind,
  ProviderChoice,
  SetupState,
} from "./types.js";

/** Hard cap on pick-list rows: the first-class catalog plus Custom fits a standard terminal. */
export const PROVIDER_LIST_ROWS_MAX = 10;
/** Floor so a short terminal still shows several options instead of one. */
export const PROVIDER_LIST_ROWS_MIN = 3;

/**
 * List height budget. This budget is a guess, not a derivation: it runs
 * before layout, so there has been no layout pass yet and nothing in OpenTUI
 * to measure — Renderable.height and scrollHeight only reflect the last
 * completed layout, populated post-mount. -14 is a hand count of the chrome
 * rows above and below the list (header, intro, step, instruction, summary,
 * statusLine, guidance, footer, and padding) with slack for a wrapped label;
 * it goes stale if that chrome changes and nothing here will catch it. A
 * shared, derived chrome budget for this and shell.ts's picker is tracked
 * separately.
 */
export function providerListHeight(renderer: CliRenderer): number {
  const rows = renderer.height || 24;
  return Math.max(
    PROVIDER_LIST_ROWS_MIN,
    Math.min(PROVIDER_LIST_ROWS_MAX, rows - 14),
  );
}

/** Catalog id for the manual path. Never written to settings as a name. */
export const CUSTOM_CHOICE_ID = "custom";

/** Pick-list row that drops the model step back to free text. */
export const TYPE_MODEL_ID = "__type_model__";

/**
 * What a signed-in subscription provider resolves to. The endpoint and model
 * list are the same constants the auth stack projects into the catalog, so a
 * first run and a later `/model` connect land on the same provider entry.
 */
export const OAUTH_SURFACES: Record<
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

function oauthChoice(
  id: string,
  label: string,
  kind: OAuthKind,
): ProviderChoice | null {
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
  const models =
    def.opencodeGo === true
      ? selectableGoModelIds()
      : isZenProviderId(def.id)
        ? selectableZenModelIds()
        : def.models;
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
  return providers.filter(
    (p) => p.name === choice.id || p.name.startsWith(prefix),
  ).length;
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
  return choices.map((choice) => {
    const accountCount = connectedAccountCount(choice, providers);
    // Once an OAuth kind has a connected account the browser-login CTA in its
    // label ("ChatGPT — Login via Browser") reads as if still unconnected, so
    // render the connected state plainly instead. The row stays listed so a
    // second account remains reachable.
    const connected =
      choice.oauth !== null && !choice.custom && accountCount > 0;
    return {
      id: choice.id,
      label: connected
        ? `${choice.label.split(" — ")[0]} · ${accountCount} connected`
        : choice.label,
      hint: choice.hint,
      accountCount,
    };
  });
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

/**
 * Accept a picked provider row: reset per-step state, prefill the preset
 * fields (Custom clears them instead), and move to the first form step.
 */
export function chooseProviderRow(
  state: SetupState,
  id: string,
  discovery: DiscoveryFlows,
): void {
  const picked = providerChoiceById(id);
  if (picked === undefined) return;
  discovery.abandonOllamaDiscovery();
  state.ollamaDiscovery = "idle";
  state.choice = picked;
  state.values.apiKey = "";
  state.typedModel = false;
  state.oauthProfileError = null;
  state.oauthProfileConfirmPending = false;
  state.confirmedSlug = null;
  if (picked.custom) {
    state.values.name = "";
    state.values.baseURL = "";
    state.values.model = "";
  } else {
    // Multi-instance first-class kinds (OAuth and API-key): leave the catalog
    // name blank until the account/instance slug is settled. See the
    // `oauthProfile` doc comment on `ProviderFormValues`.
    state.values.name = "";
    state.values.baseURL = picked.baseURL;
    state.values.model = picked.defaultModel;
    state.values.oauthProfile = "";
  }
  state.stepIndex += 1;
}

/** Rebuild the pick-list rows for the model step, then prefetch the Go catalog. */
export function enterModelListRows(
  state: SetupState,
  renderer: CliRenderer,
  discovery: DiscoveryFlows,
): void {
  if (state.choice === null) return;
  state.listRows = modelChoiceRows(state.choice);
  const active = Math.max(
    0,
    state.listRows.findIndex(
      (row) =>
        modelFromRowId(state.choice?.id ?? "", row.id) === state.values.model,
    ),
  );
  state.list = createOverlayList(renderer, {
    count: state.listRows.length,
    items: providerListHeight(renderer),
    activeIndex: active,
  });
  discovery.beginGoPrefetch();
  discovery.beginZenPrefetch();
}

/** Rebuild the pick-list rows for the provider step, keeping the prior pick focused. */
export function enterProviderRows(
  state: SetupState,
  renderer: CliRenderer,
): void {
  state.listRows = providerChoiceRows(state.choices);
  const active = Math.max(
    0,
    state.listRows.findIndex((row) => row.id === state.choice?.id),
  );
  state.list = createOverlayList(renderer, {
    count: state.listRows.length,
    items: providerListHeight(renderer),
    activeIndex: active,
  });
}
