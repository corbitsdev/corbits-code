import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Approval } from "./types.js";
import { sessionDir } from "../session/index.js";
import { SETTINGS_DIR_NAME } from "../branding.js";

// Approvals are remembered per session, alongside the run state.
function storePath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), "permissions.json");
}

// Persistent project grants live next to the project's settings. The file is
// gitignored (machine-local), so a teammate who pulls the repo never silently
// inherits another machine's auto-approvals.
function projectStorePath(cwd: string): string {
  return join(cwd, SETTINGS_DIR_NAME, "permissions.json");
}

// Persistent global and provider-model grants share one file under the user's
// home, alongside the global settings file.
function globalStorePath(home: string = homedir()): string {
  return join(home, SETTINGS_DIR_NAME, "permissions.json");
}

// Tool calls dispatch concurrently, so two approvals can resolve at nearly the
// same time. Chain writes per path so they never interleave, and write via a
// temp file + rename so a reader never observes a torn file.
const writeChains = new Map<string, Promise<void>>();

// A persisted pattern with no literal characters (e.g. "*", "**", "?") would
// auto-allow every call for its tool. The interactive classifier never produces
// such a pattern, so a file containing one was hand-edited or injected via a
// pulled/committed permissions file — reject it at the load boundary rather than
// trust it.
function hasLiteralFloor(pattern: string): boolean {
  return pattern.replace(/[*?\s]/g, "").length > 0;
}

function isApproval(value: unknown): value is Approval {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.tool === "string" &&
    typeof record.pattern === "string" &&
    hasLiteralFloor(record.pattern) &&
    (record.providerModel === undefined || typeof record.providerModel === "string")
  );
}

function parseApprovalList(raw: unknown): Approval[] {
  return Array.isArray(raw) ? raw.filter(isApproval) : [];
}

function sameApproval(a: Approval, b: Approval): boolean {
  return a.tool === b.tool && a.pattern === b.pattern && a.providerModel === b.providerModel;
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

async function readObjectFile(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Serialize the full read-modify-write per path so concurrent grants to the same
// file (a global and a provider-model grant resolving together both touch the
// global file) never lose an update, and rename atomically so a reader never
// observes a torn file.
function chainObjectWrite(
  path: string,
  mutate: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  const run = async (): Promise<void> => {
    const next = mutate(await readObjectFile(path));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, JSON.stringify(next, null, 2));
    await rename(tmp, path);
  };
  const chained = (writeChains.get(path) ?? Promise.resolve()).then(run, run);
  writeChains.set(path, chained.catch(() => undefined));
  return chained;
}

export async function loadApprovals(cwd: string, sessionId: string): Promise<Approval[]> {
  return readApprovalsField(storePath(cwd, sessionId), "approvals");
}

export async function loadProjectApprovals(cwd: string): Promise<Approval[]> {
  return readApprovalsField(projectStorePath(cwd), "approvals");
}

export async function saveProjectApproval(cwd: string, approval: Approval): Promise<void> {
  return chainObjectWrite(projectStorePath(cwd), (current) => ({
    ...current,
    approvals: [...parseApprovalList(current.approvals), approval],
  }));
}

export async function removeProjectApproval(cwd: string, target: Approval): Promise<void> {
  return chainObjectWrite(projectStorePath(cwd), (current) => ({
    ...current,
    approvals: parseApprovalList(current.approvals).filter((a) => !sameApproval(a, target)),
  }));
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

export async function saveGlobalApproval(approval: Approval, home: string = homedir()): Promise<void> {
  return chainObjectWrite(globalStorePath(home), (current) => ({
    ...current,
    approvals: [...parseApprovalList(current.approvals), approval],
  }));
}

export async function removeGlobalApproval(target: Approval, home: string = homedir()): Promise<void> {
  return chainObjectWrite(globalStorePath(home), (current) => ({
    ...current,
    approvals: parseApprovalList(current.approvals).filter((a) => !sameApproval(a, target)),
  }));
}

export async function saveProviderModelApproval(
  providerModel: string,
  approval: Approval,
  home: string = homedir(),
): Promise<void> {
  // Strip the providerModel field from the stored record; the map key carries it.
  const { providerModel: _omit, ...bare } = approval;
  return chainObjectWrite(globalStorePath(home), (current) => {
    const rawMap = current.providerModels;
    const map: Record<string, unknown> =
      typeof rawMap === "object" && rawMap !== null ? (rawMap as Record<string, unknown>) : {};
    const existing = parseApprovalList(map[providerModel]);
    return { ...current, providerModels: { ...map, [providerModel]: [...existing, bare] } };
  });
}

export async function removeProviderModelApproval(
  providerModel: string,
  target: Approval,
  home: string = homedir(),
): Promise<void> {
  const { providerModel: _omit, ...bare } = target;
  return chainObjectWrite(globalStorePath(home), (current) => {
    const rawMap = current.providerModels;
    const map: Record<string, unknown> =
      typeof rawMap === "object" && rawMap !== null ? (rawMap as Record<string, unknown>) : {};
    const remaining = parseApprovalList(map[providerModel]).filter((a) => !sameApproval(a, bare));
    return { ...current, providerModels: { ...map, [providerModel]: remaining } };
  });
}
