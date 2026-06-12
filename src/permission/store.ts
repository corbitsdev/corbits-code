import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Approval } from "./types.js";
import { sessionDir } from "../session.js";

// Approvals are remembered per session, alongside the run state.
function storePath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), "permissions.json");
}

// Persistent project grants live next to the project's settings, committed with
// the repo (no credentials, only tool/pattern allowlists).
function projectStorePath(cwd: string): string {
  return join(cwd, ".interchange", "permissions.json");
}

// Persistent global and provider-model grants share one file under the user's
// home, alongside the global settings file.
function globalStorePath(home: string = homedir()): string {
  return join(home, ".interchange", "permissions.json");
}

// Tool calls dispatch concurrently, so two approvals can resolve at nearly the
// same time. Chain writes per path so they never interleave, and write via a
// temp file + rename so a reader never observes a torn file.
const writeChains = new Map<string, Promise<void>>();

function isApproval(value: unknown): value is Approval {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.tool === "string" &&
    typeof record.pattern === "string" &&
    (record.providerModel === undefined || typeof record.providerModel === "string")
  );
}

function parseApprovalList(raw: unknown): Approval[] {
  return Array.isArray(raw) ? raw.filter(isApproval) : [];
}

async function readApprovalsField(path: string, field: string): Promise<Approval[]> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parseApprovalList(parsed?.[field]);
  } catch {
    return [];
  }
}

// Serialize writes to a single path and rename atomically so concurrent grants
// never tear the file or clobber each other.
function writeAtomic(path: string, payload: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  const run = async (): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, payload);
    await rename(tmp, path);
  };
  const chained = (writeChains.get(path) ?? Promise.resolve()).then(run, run);
  writeChains.set(path, chained.catch(() => undefined));
  return chained;
}

export async function loadApprovals(cwd: string, sessionId: string): Promise<Approval[]> {
  return readApprovalsField(storePath(cwd, sessionId), "approvals");
}

export async function saveApprovals(
  cwd: string,
  sessionId: string,
  approvals: readonly Approval[],
): Promise<void> {
  const payload = JSON.stringify({ approvals: [...approvals] }, null, 2);
  const path = storePath(cwd, sessionId);
  const tmp = `${path}.${process.pid}.tmp`;
  const run = async (): Promise<void> => {
    await mkdir(sessionDir(cwd, sessionId), { recursive: true });
    await writeFile(tmp, payload);
    await rename(tmp, path);
  };
  const chained = (writeChains.get(cwd) ?? Promise.resolve()).then(run, run);
  writeChains.set(cwd, chained.catch(() => undefined));
  return chained;
}

export async function loadProjectApprovals(cwd: string): Promise<Approval[]> {
  return readApprovalsField(projectStorePath(cwd), "approvals");
}

export async function saveProjectApproval(cwd: string, approval: Approval): Promise<void> {
  const existing = await loadProjectApprovals(cwd);
  const payload = JSON.stringify({ approvals: [...existing, approval] }, null, 2);
  return writeAtomic(projectStorePath(cwd), payload);
}

export async function loadGlobalApprovals(home: string = homedir()): Promise<Approval[]> {
  return readApprovalsField(globalStorePath(home), "approvals");
}

// Provider-model grants are stored under one keyed map in the global file. Each
// returned approval carries its `providerModel` key so the matcher can scope it.
export async function loadProviderModelApprovals(home: string = homedir()): Promise<Approval[]> {
  try {
    const raw = await readFile(globalStorePath(home), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const map = parsed?.providerModels;
    if (typeof map !== "object" || map === null) return [];
    const out: Approval[] = [];
    for (const [key, list] of Object.entries(map as Record<string, unknown>)) {
      for (const approval of parseApprovalList(list)) {
        out.push({ ...approval, providerModel: key });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function readGlobalFile(home: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(globalStorePath(home), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function saveGlobalApproval(approval: Approval, home: string = homedir()): Promise<void> {
  const current = await readGlobalFile(home);
  const existing = parseApprovalList(current.approvals);
  const next = { ...current, approvals: [...existing, approval] };
  return writeAtomic(globalStorePath(home), JSON.stringify(next, null, 2));
}

export async function saveProviderModelApproval(
  providerModel: string,
  approval: Approval,
  home: string = homedir(),
): Promise<void> {
  const current = await readGlobalFile(home);
  const rawMap = current.providerModels;
  const map: Record<string, unknown> =
    typeof rawMap === "object" && rawMap !== null ? (rawMap as Record<string, unknown>) : {};
  const existing = parseApprovalList(map[providerModel]);
  // Strip the providerModel field from the stored record; the map key carries it.
  const { providerModel: _omit, ...bare } = approval;
  const next = {
    ...current,
    providerModels: { ...map, [providerModel]: [...existing, bare] },
  };
  return writeAtomic(globalStorePath(home), JSON.stringify(next, null, 2));
}
