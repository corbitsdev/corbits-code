// Vars required for typical Node/npx MCP subprocesses to start and resolve modules.
const STDIO_MCP_ENV_ALLOWLIST = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TMPDIR",
  "TEMP",
  "TMP",
  "TERM",
  "COLORTERM",
  "SYSTEMROOT",
  "COMSPEC",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "NODE_OPTIONS",
]);

// Stdio MCP child env: inherited allowlist plus server-specific settings; the
// full parent env is not passed through, so provider credentials stay out.
export function buildStdioMcpProcessEnv(
  parentEnv: NodeJS.ProcessEnv,
  serverEnv: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of STDIO_MCP_ENV_ALLOWLIST) {
    const value = parentEnv[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  if (serverEnv !== undefined) {
    for (const [key, value] of Object.entries(serverEnv)) {
      out[key] = value;
    }
  }
  return out;
}
