import { existsSync } from "node:fs";
import path from "node:path";

// Mirrors the sole server @intx/tools-lsp registers today (Typescript):
// spawning requires a resolvable tsserver plus a reachable language-server
// binary. Checked once at session start via the filesystem and PATH — never
// by spawning a server — because the `lsp` tool's advertisement is baked into
// the wire tools array for the life of the session (see tool-search.ts).
function canResolve(request: string, cwd: string): boolean {
  try {
    Bun.resolveSync(request, cwd);
    return true;
  } catch {
    return false;
  }
}

export function detectLanguageServerAvailable(cwd: string): boolean {
  const tsserverPath = path.join(cwd, "node_modules", "typescript", "lib", "tsserver.js");
  if (!existsSync(tsserverPath) && !canResolve("typescript/lib/tsserver.js", cwd)) return false;

  const localBin = path.join(cwd, "node_modules", ".bin", "typescript-language-server");
  if (existsSync(localBin)) return true;
  if (Bun.which("typescript-language-server") !== null) return true;
  return canResolve("typescript-language-server/package.json", cwd);
}
