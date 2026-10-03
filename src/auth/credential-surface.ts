import { SETTINGS_DIR_NAME } from "../branding.js";

// Auth-owned credential surface: every settings-directory file whose bytes
// are OAuth tokens or provider credentials. The secret-guard plugin owns
// matching (lexical + realpath). Data-only — branding plus literals — so the
// import direction stays plugins → auth → branding with no cycle.
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
  { settingsDirName: SETTINGS_DIR_NAME, filename: "meta-auth.json" },
];

export const credentialDirDescriptors: CredentialDirDescriptor[] = [
  // Per-server files embed a content sha in the name, so they cannot be
  // enumerated — match the whole directory.
  { settingsDirName: SETTINGS_DIR_NAME, dirname: "mcp-auth" },
];

// Basenames whose lock/temp sidecar carries full credential bytes mid-write.
// settings.json and permissions.json keep their base patterns in the plugin;
// their sidecars are enumerated here so a torn write's temp denies the same.
const credentialSidecarBasenames: string[] = [
  ...credentialFileDescriptors.map((descriptor) => descriptor.filename),
  "settings.json",
  "permissions.json",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Deny reads/writes of credential-adjacent files without rotating, migrating, or encrypting them.
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
    // Editor backups keep full credential bytes next to the live file; scoped
    // to the settings dir and known basenames, never a generic *.bak, *~, or *.swp.
    patterns.push(new RegExp(`(^|\\/)${dir}\\/${base}\\.bak[^/]*$`));
    patterns.push(new RegExp(`(^|\\/)${dir}\\/${base}~$`));
    patterns.push(new RegExp(`(^|\\/)${dir}\\/${base}\\.swp$`));
    patterns.push(new RegExp(`(^|\\/)${dir}\\/\\.${base}\\.swp$`));
    patterns.push(new RegExp(`(^|\\/)${dir}\\/${base}\\.lock$`));
    // Writers emit a pid.counter middle segment (auth/store.ts, mcp/auth-store.ts),
    // so the middle segment is required; a bare `<base>.tmp` has no known writer.
    patterns.push(new RegExp(`(^|\\/)${dir}\\/${base}\\.[^/]*\\.tmp$`));
  }
  return patterns;
}
