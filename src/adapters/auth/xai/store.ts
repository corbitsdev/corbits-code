import { createAuthStore, type AuthProfile, type BaseTokens } from "../oauth/store.js";

export type XaiTokens = BaseTokens & {
  idToken?: string;
};

export type XaiProfile = AuthProfile<XaiTokens>;

function isXaiTokens(value: unknown): value is XaiTokens {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.access === "string" &&
    typeof t.refresh === "string" &&
    typeof t.expiresAt === "number" &&
    (t.idToken === undefined || typeof t.idToken === "string")
  );
}

const store = createAuthStore<XaiTokens>({
  filename: "xai-auth.json",
  isTokens: isXaiTokens,
});

export const xaiAuthPath = store.authPath;
export const listXaiProfiles = store.listProfiles;
export const loadXaiProfile = store.loadProfile;
export const saveXaiProfile = store.saveProfile;
export const updateXaiTokens = store.updateTokens;
export const removeXaiProfile = store.removeProfile;
