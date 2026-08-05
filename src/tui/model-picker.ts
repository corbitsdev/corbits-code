import type { ModelRef } from "../config/settings.js";
import { DEFAULT_RECENT_MODELS_SHOWN } from "../config/settings.js";

export type ModelPickSection = "recent" | "favorites" | "provider";

export type ModelPick = {
  provider: string;
  model: string;
  section: ModelPickSection;
  providerLabel?: string;
  account?: string;
  warning?: string;
};

export type ModelPickerProvider = {
  name: string;
  models: string[];
  defaultModel?: string;
  codexProfile?: string;
  xaiProfile?: string;
  opencodeGo?: boolean;
  baseURL?: string;
  /** Display name for the provider bucket / row (falls back to `name`). */
  label?: string;
  /** Account or profile label when known (e.g. OAuth login name). */
  account?: string;
};

export type BuildModelsFirstListArgs = {
  providers: ModelPickerProvider[];
  recent: ModelRef[];
  favorites: ModelRef[];
  /** Max recent rows (default 5). */
  recentMax?: number;
  /**
   * When true for a model on a provider, attach a cross-product billing warning
   * (Go model configured on a Zen-billed path).
   */
  isGoModelOnZenPath?: (model: string, provider: ModelPickerProvider) => boolean;
};

const GO_ON_ZEN_WARNING = "Go model on Zen path — billed as Zen credits";

function refKey(provider: string, model: string): string {
  return `${provider}\0${model}`;
}

function modelExistsOnProvider(
  providers: ModelPickerProvider[],
  provider: string,
  model: string,
): ModelPickerProvider | undefined {
  const p = providers.find((x) => x.name === provider);
  if (p === undefined) return undefined;
  return p.models.includes(model) ? p : undefined;
}

function pickRow(
  provider: ModelPickerProvider,
  model: string,
  section: ModelPickSection,
  isGoModelOnZenPath?: (model: string, provider: ModelPickerProvider) => boolean,
): ModelPick {
  const warning =
    isGoModelOnZenPath?.(model, provider) === true ? GO_ON_ZEN_WARNING : undefined;
  return {
    provider: provider.name,
    model,
    section,
    providerLabel: provider.label ?? provider.name,
    ...(provider.account !== undefined ? { account: provider.account } : {}),
    ...(warning !== undefined ? { warning } : {}),
  };
}

/**
 * Models-first picker rows: Recent (still-valid, capped) → Favorites (not already
 * in Recent) → each connected provider's models (skipping pairs already listed).
 * Identity is provider+model.
 */
export function buildModelsFirstList(args: BuildModelsFirstListArgs): ModelPick[] {
  const recentMax = args.recentMax ?? DEFAULT_RECENT_MODELS_SHOWN;
  const seen = new Set<string>();
  const out: ModelPick[] = [];

  for (const ref of args.recent) {
    if (out.filter((r) => r.section === "recent").length >= recentMax) break;
    const provider = modelExistsOnProvider(args.providers, ref.provider, ref.model);
    if (provider === undefined) continue;
    const key = refKey(ref.provider, ref.model);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pickRow(provider, ref.model, "recent", args.isGoModelOnZenPath));
  }

  for (const ref of args.favorites) {
    const provider = modelExistsOnProvider(args.providers, ref.provider, ref.model);
    if (provider === undefined) continue;
    const key = refKey(ref.provider, ref.model);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pickRow(provider, ref.model, "favorites", args.isGoModelOnZenPath));
  }

  for (const provider of args.providers) {
    for (const model of provider.models) {
      const key = refKey(provider.name, model);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(pickRow(provider, model, "provider", args.isGoModelOnZenPath));
    }
  }

  return out;
}
