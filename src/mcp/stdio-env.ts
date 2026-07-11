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

// Build the environment for a stdio MCP child: a small inherited allowlist plus
// server-specific entries from settings. The full parent process.env is not passed
// through, so provider credentials and unrelated secrets stay out of MCP servers.
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