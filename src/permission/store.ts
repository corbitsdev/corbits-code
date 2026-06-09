import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { Approval } from "./types.js";
import { sessionDir } from "../session.js";

// Approvals are remembered per session, alongside the run state.
function storePath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), "permissions.json");
}

// Tool calls dispatch concurrently, so two approvals can resolve at nearly the
// same time. Chain writes per directory so they never interleave, and write via
// a temp file + rename so a reader never observes a torn file.
const writeChains = new Map<string, Promise<void>>();

function isApproval(value: unknown): value is Approval {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).tool === "string" &&
    typeof (value as Record<string, unknown>).pattern === "string"
  );
}

export async function loadApprovals(cwd: string, sessionId: string): Promise<Approval[]> {
  try {
    const raw = await readFile(storePath(cwd, sessionId), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const list = (parsed as Record<string, unknown>)?.approvals;
    if (!Array.isArray(list)) return [];
    return list.filter(isApproval);
  } catch {
    return [];
  }
}

export async function saveApprovals(
  cwd: string,
  sessionId: string,
  approvals: readonly Approval[],
): Promise<void> {
  // Snapshot now so the serialized payload reflects the array at call time.
  const payload = JSON.stringify({ approvals: [...approvals] }, null, 2);
  const path = storePath(cwd, sessionId);
  const tmp = `${path}.${process.pid}.tmp`;

  const run = async (): Promise<void> => {
    await mkdir(sessionDir(cwd, sessionId), { recursive: true });
    await writeFile(tmp, payload);
    await rename(tmp, path);
  };

  const chained = (writeChains.get(cwd) ?? Promise.resolve()).then(run, run);
  // Keep the chain alive but never let a rejection poison the next write.
  writeChains.set(cwd, chained.catch(() => undefined));
  return chained;
}
