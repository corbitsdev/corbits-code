import { SETTINGS_DIR_NAME } from "../branding.js";

// Auth-owned credential surface: every file under the settings directory whose
// bytes are OAuth tokens or provider credentials. The secret-guard plugin owns
// matching (lexical + realpath); mention-resolution consumes the resolved
// check. This module stays data-only — branding plus literals, no store
// factories or homedir calls — so the import direction stays plugins → auth →
// branding with no cycle.
export interface CredentialFileDescriptor {
  settingsDirName: string;
  filename: string;
}

export interface CredentialDirDescriptor {
  settingsDirName: string;
  dirname: string;
}

export const credentialFileDescriptors: CredentialFileDescriptor[] = [
  { settingsDirName: SETTINGS_DIR_NAME, filename: "codex-auth.json" },
  { settingsDirName: SETTINGS_DIR_NAME, filename: "xai-auth.json" },
];

export const credentialDirDescriptors: CredentialDirDescriptor[] = [
  // Per-server files embed a content sha in the name, so they cannot be
  // enumerated — match the whole directory instead.
  { settingsDirName: SETTINGS_DIR_NAME, dirname: "mcp-auth" },
];

// Every basename whose lock/temp sidecar carries full credential bytes
// mid-write. settings.json and permissions.json keep their hand-written base
// patterns in the plugin; their sidecars are still enumerated here so a torn
// write's temp file denies the same as the file itself.
const credentialSidecarBasenames: string[] = [
  ...credentialFileDescriptors.map((descriptor) => descriptor.filename),
  "settings.json",
  "permissions.json",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Guard-only patterns: deny reads/writes of credential-adjacent files without
// rotating, migrating, or encrypting them.
export function buildCredentialPatterns(): RegExp[] {
  const dir = escapeRegExp(SETTINGS_DIR_NAME);
  const patterns: RegExp[] = [];
  for (const { settingsDirName, filename } of credentialFileDescriptors) {
    const scope = escapeRegExp(settingsDirName);
    patterns.push(new RegExp(`(^|\\/)${scope}\\/${escapeRegExp(filename)}$`));
  }
  for (const { settingsDirName, dirname } of credentialDirDescriptors) {
    const scope = escapeRegExp(settingsDirName);
    patterns.push(new RegExp(`(^|\\/)${scope}\\/${escapeRegExp(dirname)}\\/`));
  }
  for (const basename of credentialSidecarBasenames) {
    const base = escapeRegExp(basename);
    // Editor backup copies keep full credential bytes next to the live file.
    // Scoped to the settings dir and anchored to known basenames, never a
    // generic *.bak, *~, or *.swp.
    patterns.push(new RegExp(`(^|\\/)${dir}\\/${base}\\.bak[^/]*$`));
    patterns.push(new RegExp(`(^|\\/)${dir}\\/${base}~$`));
    patterns.push(new RegExp(`(^|\\/)${dir}\\/${base}\\.swp$`));
    patterns.push(new RegExp(`(^|\\/)${dir}\\/\\.${base}\\.swp$`));
    patterns.push(new RegExp(`(^|\\/)${base}\\.lock$`));
    // Writers emit a pid.counter middle segment (auth/store.ts,
    // mcp/auth-store.ts), so the middle segment is required; a bare
    // `<base>.tmp` has no known writer and stays unmatched.
    patterns.push(new RegExp(`(^|\\/)${base}\\.[^/]*\\.tmp$`));
  }
  return patterns;
}
