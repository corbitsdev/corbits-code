import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type } from "arktype";

import { sessionDir } from "./index.js";
import { COMMAND_NAME } from "../branding.js";

const ConnectedMcpServerSchema = type({
  name: "string",
  toolCount: "number",
});

export type ConnectedMcpServer = typeof ConnectedMcpServerSchema.infer;

const RunStateSchema = type({
  status: "'running' | 'done' | 'failed' | 'cancelled'",
  turnsUsed: "number",
  task: "string",
  startedAt: "number",
  "finishedAt?": "number",
  "error?": "string",
  // The resolved "provider:model" identity in use when this record was written.
  // Absent only for records predating this field or written outside the run
  // lifecycle (e.g. a bare rename of a session with no prior state).
  "model?": "string",
  // MCP servers connected during the session, with the tool count each
  // contributed. Empty until the first server finishes connecting.
  "mcpServers?": ConnectedMcpServerSchema.array(),
});

export type RunState = typeof RunStateSchema.infer;

function statePath(cwd: string, sessionId: string, home?: string): string {
  return join(sessionDir(cwd, sessionId, home), "run.json");
}


let tmpWriteCounter = 0;

// Write atomically: serialize to a unique temp file, then rename into place so a
// crash mid-write never leaves torn JSON. The temp name combines the pid with a
// monotonic counter so concurrent or rapid successive saves within one process
// never collide on the same temp path (pid alone is not unique per call).
export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${(tmpWriteCounter += 1)}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

// A corrupt or shape-invalid state file means resume is silently starting over
// and prior progress is being discarded. Surface it rather than swallowing it.
export function warnUnreadableState(path: string, reason: string): void {
  process.stderr.write(`${COMMAND_NAME}: ignoring unreadable state at ${path} (${reason}); starting fresh\n`);
}

// Concurrent saveState calls for the same session (a straggler progress
// snapshot racing a terminal finalize write) have no ordering guarantee
// between their underlying rename()s — the later call could still finish
// first and resurrect a closed run.json as "running". Chaining each session's
// writes onto the previous one forces them to apply in call order, so a
// write issued after another always lands after it regardless of how long
// either write's fs calls take. Keyed by sessionId, not path, since callers
// only ever address one file per session.
const writeChains = new Map<string, Promise<void>>();

export async function saveState(
  cwd: string,
  sessionId: string,
  state: RunState,
  home?: string,
): Promise<void> {
  const path = statePath(cwd, sessionId, home);
  const content = JSON.stringify(state, null, 2);
  const previous = writeChains.get(sessionId) ?? Promise.resolve();
  const write = previous.then(
    () => atomicWrite(path, content),
    () => atomicWrite(path, content),
  );
  // Swallow the error in the chain tail (not in `write`, which still rejects
  // for this caller) so one failed save doesn't permanently wedge later
  // saves for the same session.
  const tail = write.catch(() => {});
  writeChains.set(sessionId, tail);
  // Once this is the last write for the session, drop the entry so a
  // long-lived process doesn't retain a chain per session forever.
  void tail.then(() => {
    if (writeChains.get(sessionId) === tail) writeChains.delete(sessionId);
  });
  return write;
}


// Returns the parsed state, or the arktype error summary when the shape is
// invalid, so callers can surface a specific reason rather than "invalid shape".
function parseRunState(data: unknown): RunState | { error: string } {
  const result = RunStateSchema(data);
  return result instanceof type.errors ? { error: result.summary } : result;
}

export async function loadState(
  cwd: string,
  sessionId: string,
  home?: string,
): Promise<RunState | null> {
  const path = statePath(cwd, sessionId, home);

  try {
    const raw = await readFile(path, "utf8");
    const parsed = parseRunState(JSON.parse(raw));
    if ("error" in parsed) {
      warnUnreadableState(path, `invalid shape: ${parsed.error}`);
      return null;
    }
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) {
      warnUnreadableState(path, "corrupt JSON");
      return null;
    }
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}
