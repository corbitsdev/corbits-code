import { SETTINGS_DIR_NAME } from "../branding.js";
import { createCodexAuthStore } from "../auth/codex/store.js";
import { createXaiAuthStore } from "../auth/xai/store.js";

const xaiAuthStore = createXaiAuthStore(SETTINGS_DIR_NAME);
const codexAuthStore = createCodexAuthStore(SETTINGS_DIR_NAME);

export const xaiAuthPath = xaiAuthStore.authPath;
export const listXaiProfiles = xaiAuthStore.listProfiles;
export const loadXaiProfile = xaiAuthStore.loadProfile;
export const saveXaiProfile = xaiAuthStore.saveProfile;
export const updateXaiTokens = xaiAuthStore.updateTokens;
export const removeXaiProfile = xaiAuthStore.removeProfile;

export const codexAuthPath = codexAuthStore.authPath;
export const listCodexProfiles = codexAuthStore.listProfiles;
export const loadCodexProfile = codexAuthStore.loadProfile;
export const saveCodexProfile = codexAuthStore.saveProfile;
export const updateCodexTokens = codexAuthStore.updateTokens;
export const removeCodexProfile = codexAuthStore.removeProfile;
