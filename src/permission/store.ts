import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { type } from "arktype";

import type { Approval } from "./types.js";
import { sessionDir } from "../session/index.js";
import { SETTINGS_DIR_NAME } from "../branding.js";
import {
  isProjectGrantTrusted,
  reconcileProjectGrants,
  trustProjectGrants,
  untrustProjectGrants,
} from "../trust/project-trust.js";

// Approvals are remembered per session, alongside the run state.
function storePath(cwd: string, sessionId: string, home?: string): string {
  return join(sessionDir(cwd, sessionId, home), "permissions.json");
}

// Persistent project grants live next to the project's settings. The file is
// gitignored (machine-local), so a pull never inherits another machine's
// auto-approvals.
function projectStorePath(cwd: string): string {
  return join(cwd, SETTINGS_DIR_NAME, "permissions.json");
}

// Persistent global and provider-model grants share one file under the user's
// home, alongside the global settings file.
function globalStorePath(home: string = homedir()): string {
  return join(home, SETTINGS_DIR_NAME, "permissions.json");
}

// Tool calls dispatch concurrently, so approvals can resolve at nearly the
// same time. Chain writes per path so they never interleave, and write via a
// temp file + rename so a reader never observes a torn file.
const writeChains = new Map<string, Promise<void>>();

// A wildcard-only pattern ("*", "**", "?") would auto-allow every call.
// The classifier never mints one, so reject such files at the load boundary:
// they were hand-edited or pulled from a committed permissions file.
function hasLiteralFloor(pattern: string): boolean {
  return pattern.replace(/[*?\s]/g, "").length > 0;
}

const ApprovalSchema = type({
  tool: "string",
  pattern: "string",
  "providerModel?": "string",
}).narrow(
  (approval, ctx) =>
    hasLiteralFloor(approval.pattern) ||
    ctx.mustBe("a pattern with a literal floor (not only wildcards)"),
);

function parseApprovalList(raw: unknown): Approval[] {
  if (!Array.isArray(raw)) return [];
  const out: Approval[] = [];
  for (const entry of raw) {
    const result = ApprovalSchema(entry);
    if (!(result instanceof type.errors)) out.push(result);
  }
  return out;
}

function sameApproval(a: Approval, b: Approval): boolean {
  // Removal equality ignores cwd: revocation targets arrive cwd-less (see
  // admin.ts toApproval), so a strict comparison would keep a confined twin
  // live. Removing the file entry is the revocation; the next load's
  // reconcile prunes the cwd-bound fingerprint with it.
  return (
    a.tool === b.tool &&
    a.pattern === b.pattern &&
    a.providerModel === b.providerModel
  );
}

// Equality on every confirmed dimension except cwd: a planted file entry and
// the gate's minted confirmation of it differ only in cwd.
const sameGrantModuloCwd = sameApproval;

async function readApprovalsField(
  path: string,
  field: string,
): Promise<Approval[]> {
  return parseApprovalList((await readObjectFile(path))[field]);
}

async function readObjectFile(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// Serialize read-modify-write per path so concurrent grants to one file (a
// global and a provider-model grant resolving together both touch the global
// file) never lose an update; rename atomically so no reader sees a torn
// file. Returning undefined from mutate skips the write, keeping migrations
// that find nothing to purge byte-identical no-ops.
export function chainObjectWrite(
  path: string,
  mutate: (
    current: Record<string, unknown>,
  ) =>
    | Record<string, unknown>
    | undefined
    | Promise<Record<string, unknown> | undefined>,
): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  const run = async (): Promise<void> => {
    const next = await mutate(await readObjectFile(path));
    if (next === undefined) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, JSON.stringify(next, null, 2));
    await rename(tmp, path);
  };
  const chained = (writeChains.get(path) ?? Promise.resolve()).then(run, run);
  writeChains.set(
    path,
    chained.catch(() => undefined),
  );
  return chained;
}

export async function loadApprovals(
  cwd: string,
  sessionId: string,
  home?: string,
): Promise<Approval[]> {
  return readApprovalsField(storePath(cwd, sessionId, home), "approvals");
}

// The project approvals file is repo content — committable, copyable,
// plantable — so its entries are NOT approvals until the operator confirms
// each one (see trustedGrantFingerprints). An untrusted directory therefore
// contributes zero approvals here; unconfirmed entries surface via
// loadPendingProjectApprovals so the first encounter shows what the file
// would grant instead of dropping it silently. Project trust never implies
// grant trust: plugin/MCP trust only loads code or connects a server, while
// a grant auto-allows future calls and needs its own confirmation. Trust
// follows the file: each load drops fingerprints with no on-disk entry, so
// removing an entry revokes its confirmation — a byte-identical replant
// re-surfaces as pending.
export async function loadProjectApprovals(
  cwd: string,
  home?: string,
): Promise<Approval[]> {
  const onDisk = await readApprovalsField(projectStorePath(cwd), "approvals");
  const trust = await reconcileProjectGrants(cwd, onDisk, home);
  return onDisk.filter((approval) => isProjectGrantTrusted(trust, approval));
}

/**
 * Project-file entries the operator has not confirmed yet: the first
 * encounter surfaces them. Non-empty means "this directory ships a
 * permissions file you have not reviewed" — show
 * formatPendingProjectApprovals output instead of applying or silently
 * ignoring the file.
 */
export async function loadPendingProjectApprovals(
  cwd: string,
  home?: string,
): Promise<Approval[]> {
  const onDisk = await readApprovalsField(projectStorePath(cwd), "approvals");
  if (onDisk.length === 0) return [];
  const trust = await reconcileProjectGrants(cwd, onDisk, home);
  return onDisk.filter((approval) => !isProjectGrantTrusted(trust, approval));
}

/** Operator-facing rendering of unconfirmed project-file entries. */
export function formatPendingProjectApprovals(pending: Approval[]): string {
  if (pending.length === 0) return "";
  const lines = pending.map(
    (approval) =>
      `  - ${approval.tool}: "${approval.pattern}"${approval.providerModel ? ` (only with ${approval.providerModel})` : ""}`,
  );
  return [
    "This directory contains a project approvals file with entries you have not confirmed:",
    ...lines,
    "Nothing from this file is applied until you confirm each entry.",
  ].join("\n");
}

export async function saveProjectApproval(
  cwd: string,
  approval: Approval,
  home?: string,
): Promise<void> {
  await chainObjectWrite(projectStorePath(cwd), (current) => ({
    ...current,
    approvals: [
      // A planted entry carries no cwd; confirming it through the pending
      // flow mints {tool, pattern, cwd} and writes that shape back here.
      // Displace its twin instead of stacking a duplicate that would linger
      // pending forever — the dropped twin never applied, so nothing
      // confirmed is lost. A save without cwd appends plainly and never
      // displaces a confined entry.
      ...parseApprovalList(current.approvals).filter(
        (entry) =>
          approval.cwd === undefined || !sameGrantModuloCwd(entry, approval),
      ),
      approval,
    ],
  }));
  // Only the interactive grant path writes here, so writing an entry is
  // itself the confirmation its fingerprint needs.
  await trustProjectGrants(cwd, [approval], home);
}

export async function removeProjectApproval(
  cwd: string,
  target: Approval,
  home?: string,
): Promise<void> {
  await chainObjectWrite(projectStorePath(cwd), (current) => ({
    ...current,
    approvals: parseApprovalList(current.approvals).filter(
      (a) => !sameApproval(a, target),
    ),
  }));
  await untrustProjectGrants(cwd, [target], home);
}

export async function loadGlobalApprovals(
  home: string = homedir(),
): Promise<Approval[]> {
  return readApprovalsField(globalStorePath(home), "approvals");
}

// Provider-model grants are stored under one keyed map in the global file.
// Each returned approval carries its `providerModel` key so the matcher can
// scope it.
export async function loadProviderModelApprovals(
  home: string = homedir(),
): Promise<Approval[]> {
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

export async function saveGlobalApproval(
  approval: Approval,
  home: string = homedir(),
): Promise<void> {
  return chainObjectWrite(globalStorePath(home), (current) => ({
    ...current,
    approvals: [...parseApprovalList(current.approvals), approval],
  }));
}

export async function removeGlobalApproval(
  target: Approval,
  home: string = homedir(),
): Promise<void> {
  return chainObjectWrite(globalStorePath(home), (current) => ({
    ...current,
    approvals: parseApprovalList(current.approvals).filter(
      (a) => !sameApproval(a, target),
    ),
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
      typeof rawMap === "object" && rawMap !== null
        ? (rawMap as Record<string, unknown>)
        : {};
    const existing = parseApprovalList(map[providerModel]);
    return {
      ...current,
      providerModels: { ...map, [providerModel]: [...existing, bare] },
    };
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
      typeof rawMap === "object" && rawMap !== null
        ? (rawMap as Record<string, unknown>)
        : {};
    const remaining = parseApprovalList(map[providerModel]).filter(
      (a) => !sameApproval(a, bare),
    );
    return {
      ...current,
      providerModels: { ...map, [providerModel]: remaining },
    };
  });
}
