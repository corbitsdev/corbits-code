// Codex profile store — see the shared factory in ./provider.ts.
//
// On-disk store for Codex OAuth profiles. A user may hold multiple Codex
// subscriptions (personal, work, ...), so credentials are keyed by a
// user-chosen profile name within a single file. The provider type is shared;
// the profile name is what differentiates instances throughout the app.
import type { AuthProfile } from "../oauth/store.js";
import { codexAuth } from "./provider.js";
import type { CodexTokens } from "./provider.js";

export type { CodexTokens } from "./provider.js";

export type CodexProfile = AuthProfile<CodexTokens>;

export const codexAuthPath = codexAuth.store.authPath;
export const listCodexProfiles = codexAuth.store.listProfiles;
export const loadCodexProfile = codexAuth.store.loadProfile;
export const saveCodexProfile = codexAuth.store.saveProfile;
export const updateCodexTokens = codexAuth.store.updateTokens;
export const removeCodexProfile = codexAuth.store.removeProfile;
