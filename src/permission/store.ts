import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Approval } from "./types.js";

// Approvals are remembered per working directory, alongside the run state.
function storePath(cwd: string): string {
  return join(cwd, ".agent-state", "permissions.json");
}

function isApproval(value: unknown): value is Approval {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).tool === "string" &&
    typeof (value as Record<string, unknown>).pattern === "string"
  );
}

export async function loadApprovals(cwd: string): Promise<Approval[]> {
  try {
    const raw = await readFile(storePath(cwd), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const list = (parsed as Record<string, unknown>)?.approvals;
    if (!Array.isArray(list)) return [];
    return list.filter(isApproval);
  } catch {
    return [];
  }
}

export async function saveApprovals(cwd: string, approvals: readonly Approval[]): Promise<void> {
  const path = storePath(cwd);
  await mkdir(join(cwd, ".agent-state"), { recursive: true });
  await writeFile(path, JSON.stringify({ approvals }, null, 2));
}
