// xAI profile store — see the shared factory in ./provider.ts.
import type { AuthProfile } from "../oauth/store.js";
import { xaiAuth } from "./provider.js";
import type { XaiTokens } from "./provider.js";

export type { XaiTokens } from "./provider.js";

export type XaiProfile = AuthProfile<XaiTokens>;

export const xaiAuthPath = xaiAuth.store.authPath;
export const listXaiProfiles = xaiAuth.store.listProfiles;
export const loadXaiProfile = xaiAuth.store.loadProfile;
export const saveXaiProfile = xaiAuth.store.saveProfile;
export const updateXaiTokens = xaiAuth.store.updateTokens;
export const removeXaiProfile = xaiAuth.store.removeProfile;
