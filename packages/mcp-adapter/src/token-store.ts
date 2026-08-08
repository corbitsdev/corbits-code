import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

// Per-server OAuth state persisted between processes. Holding the PKCE
// verifier is necessary because authorization spans a process boundary
// (browser round-trip); tokens and dynamically-registered client info let
// later connections reconnect without any user interaction.
export type McpAuthState = {
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
};

export function mcpAuthDir(home: string = homedir()): string {
  return join(home, ".corbits", "mcp-auth");
}

// Server names are caller-controlled and may contain path separators or
// other unsafe characters; reduce to a flat slug so the file path can
// never escape the auth directory.
function authFilePath(serverName: string, home: string): string {
  const slug = serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(mcpAuthDir(home), `${slug}.json`);
}

export async function loadAuthState(serverName: string, home: string = homedir()): Promise<McpAuthState> {
  let raw: string;
  try {
    raw = await readFile(authFilePath(serverName, home), "utf8");
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      return {};
    }
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) return parsed as McpAuthState;
  } catch {
    // A corrupt auth file should not wedge the connection; treat it as no
    // state and let a fresh authorization overwrite it.
  }
  return {};
}

// Tokens are credentials, so the directory and file are restricted to the owner.
export async function saveAuthState(serverName: string, state: McpAuthState, home: string = homedir()): Promise<void> {
  const path = authFilePath(serverName, home);
  await mkdir(mcpAuthDir(home), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}
