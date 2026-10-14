import { type, type Type } from "arktype";
import type { BaseTokens } from "@corbits/oauth-core";

import { createAuthStore, type AuthStore } from "./store.js";

export interface ProviderAuthStoreDefinition<TTokens extends BaseTokens> {
  filename: string;
  tokensShape: Type<TTokens>;
}

// The per-provider auth store definition: one filename plus the arktype
// shape guarding what may load from disk; nothing else differs.
export function defineProviderAuthStore<TTokens extends BaseTokens>(
  definition: ProviderAuthStoreDefinition<TTokens>,
): (settingsDirName: string) => AuthStore<TTokens> {
  const { filename, tokensShape } = definition;
  const isTokens = (value: unknown): value is TTokens =>
    !(tokensShape(value) instanceof type.errors);
  return (settingsDirName: string) =>
    createAuthStore<TTokens>({ filename, settingsDirName, isTokens });
}
