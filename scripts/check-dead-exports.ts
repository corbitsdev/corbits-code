import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Dead-export guard: runs knip and fails when a consumer-less export or an
// unused file falls outside scripts/dead-export-allowlist.txt. knip resolves
// the module graph, so an export consumed through a re-export barrel or the
// closed director fan-in is not reported, and exports used only inside their
// own module are skipped (ignoreExportsUsedInFile in knip.json). knip.json
// pins the scan; this guard owns only the allowlist and the fail-closed floor.
// New dead exports must be deleted, not allowlisted — the allowlist names
// entry-point API surfaces only. vendor/ and path-loaded eval fixtures are
// knip ignore entries, not allowlist blankets.
//
// Hardening: stale entries fail instead of warning, every entry must pass
// shape validation and sit under a reason comment (the gate enforces the
// reason; review enforces the owning lane), the file-count floor is computed
// from the pinned tsconfig and the gate fails closed under it, and the knip
// invocation is pinned in code (reporter + flags) so the scan cannot be
// narrowed from the guard config.

// Test injection: a subprocess test can pass the deterministic file count
// instead of paying for the ~1.5s tsc --listFilesOnly run. Production never
// sets it, so the gate always computes the count in normal runs.
const scannedFilesEnv = "DEAD_EXPORT_GUARD_SCANNED_FILES";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const allowlistPath = join(here, "dead-export-allowlist.txt");
const guardConfigPath = join(here, "dead-export-guard.json");
const knipBin = join(repoRoot, "node_modules", ".bin", "knip");
const tscBin = join(repoRoot, "node_modules", "typescript", "bin", "tsc");

// The integrated-monorepo knip config that drives the production agent scan.
// A separate file so the default scan keeps knip.json's project scope (the
// `workspaces` key switches knip into integrated mode, which also widens its
// default file detection beyond that scope).
export function agentsConfigPath(): string {
  return join(repoRoot, "knip.agents.json");
}

export type AllowRule =
  | {
      readonly kind: "prefix";
      readonly prefix: string;
      readonly source: string;
    }
  | {
      readonly kind: "exact";
      readonly file: string;
      readonly name: string;
      readonly source: string;
    };

export interface DeadExport {
  readonly file: string;
  readonly name: string;
}

export interface GuardOutcome {
  readonly dead: number;
  readonly violations: string[];
  readonly unused: string[];
}

export interface GuardConfig {
  readonly tsconfig: string;
  readonly minScannedFiles: number;
}

const exactEntryPattern = /^(.+?): ([A-Za-z_$][\w$]*)$/;

export function parseAllowlistText(text: string): AllowRule[] {
  const rules: AllowRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const exact = line.match(exactEntryPattern);
    if (exact) {
      const file = exact[1];
      const name = exact[2];
      if (file !== undefined && name !== undefined) {
        rules.push({
          kind: "exact",
          file: file.trim(),
          name: name.trim(),
          source: line,
        });
      }
    } else {
      rules.push({ kind: "prefix", prefix: line, source: line });
    }
  }
  return rules;
}

// Rejects a line the matcher would silently misinterpret: a mistyped exact
// entry must not decay into a prefix, and a slash-less directory must not
// pass as an imprecise prefix. Only `dir/` prefixes and repo-relative `.ts`
// paths (bare or `file: Name`) are valid.
export function validateAllowlistEntry(line: string): string | undefined {
  if (line.includes(":")) {
    const exact = line.match(exactEntryPattern);
    if (exact === null) {
      return `malformed allowlist entry (want "path/to/file.ts: ExportName"): ${line}`;
    }
    const file = exact[1] ?? "";
    if (/\s/.test(file) || !file.includes("/") || !file.endsWith(".ts")) {
      return `allowlist entry file must be a repo-relative .ts path: ${line}`;
    }
    return undefined;
  }
  if (/\s/.test(line)) {
    return `allowlist entry contains whitespace: ${line}`;
  }
  if (line.endsWith("/")) {
    if (line.length < 2) {
      return `malformed allowlist entry: ${line}`;
    }
    return undefined;
  }
  if (!line.includes("/") || !line.endsWith(".ts")) {
    return `directory prefixes must end in "/" and files must end in ".ts": ${line}`;
  }
  return undefined;
}

export function validateAllowlistText(text: string): string[] {
  const problems: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const problem = validateAllowlistEntry(line);
    if (problem !== undefined) problems.push(problem);
  }
  return problems;
}

// Every entry must sit under a reason comment in the same blank-line section.
// The gate enforces the reason's presence; review enforces that it names the
// owning lane, so exemptions cannot land without a reason on record.
export function validateAllowlistOwnership(text: string): string[] {
  const problems: string[] = [];
  let reasoned = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      reasoned = false;
      continue;
    }
    if (line.startsWith("#")) {
      if (line.length > 1) reasoned = true;
      continue;
    }
    if (!reasoned) {
      problems.push(
        `allowlist entry without a reason comment naming its owner: ${line}`,
      );
    }
  }
  return problems;
}

export function loadAllowlist(): AllowRule[] {
  return parseAllowlistText(readFileSync(allowlistPath, "utf8"));
}

// The counted floor must be a positive integer the gate fails closed against.
// Unknown keys reject: a config carrying a retired or misnamed scan knob must
// not silently narrow how the gate runs.
export function parseGuardConfig(raw: unknown): GuardConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("dead-export guard config must be a JSON object");
  }
  const config = raw as Record<string, unknown>;
  const known = new Set(["tsconfig", "minScannedFiles"]);
  for (const key of Object.keys(config)) {
    if (!known.has(key)) {
      throw new Error(`dead-export guard config has an unexpected key: ${key}`);
    }
  }
  const tsconfig = config["tsconfig"];
  if (typeof tsconfig !== "string" || tsconfig === "") {
    throw new Error('dead-export guard config needs a "tsconfig" path string');
  }
  const minScannedFiles = config["minScannedFiles"];
  if (
    typeof minScannedFiles !== "number" ||
    !Number.isInteger(minScannedFiles) ||
    minScannedFiles <= 0
  ) {
    throw new Error(
      'dead-export guard config needs a positive integer "minScannedFiles"',
    );
  }
  return { tsconfig, minScannedFiles };
}

export function loadGuardConfig(): GuardConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(guardConfigPath, "utf8"));
  } catch (err) {
    throw new Error(
      `cannot read ${guardConfigPath}: ${(err as Error).message}`,
    );
  }
  const config = parseGuardConfig(raw);
  if (!existsSync(join(repoRoot, config.tsconfig))) {
    throw new Error(`tsconfig not found: ${config.tsconfig}`);
  }
  return config;
}

export function isAllowlisted(
  rules: AllowRule[],
  file: string,
  name: string,
): boolean {
  return rules.some((rule) =>
    rule.kind === "prefix"
      ? file.startsWith(rule.prefix)
      : rule.file === file && rule.name === name,
  );
}

// knip issue items are { name } objects (plus position fields the guard never
// reads); a `files` item carries the file path in `name`.
interface KnipReportItem {
  readonly name: unknown;
}

// The knip issue classes the guard counts. knip.json enables exports, types,
// enumMembers, namespaceMembers, and files and turns everything else off, so
// this list is the closed set the reporter can surface findings under.
const knipFindingClasses = [
  "exports",
  "types",
  "enumMembers",
  "namespaceMembers",
] as const;
type KnipFindingClass = (typeof knipFindingClasses)[number];

function isFindingClass(value: string): value is KnipFindingClass {
  return (knipFindingClasses as readonly string[]).includes(value);
}

// Parses one knip --reporter json stdout blob into dead-export findings.
// Malformed shapes throw: a mis-parsed report must fail closed, not pass.
// `files` issues become one finding per file (the unreachable file is the
// maximal consumer-less export); everything else is (file, export name).
export function parseKnipReport(raw: string): DeadExport[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`knip report is not valid JSON: ${(err as Error).message}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("issues" in parsed) ||
    !Array.isArray(parsed.issues)
  ) {
    throw new Error("knip report is missing its issues array");
  }
  const findings: DeadExport[] = [];
  for (const issue of parsed.issues) {
    if (typeof issue !== "object" || issue === null) {
      throw new Error("knip report issue is not an object");
    }
    const entry = issue as Record<string, unknown>;
    if (typeof entry.file !== "string") {
      throw new Error("knip report issue is missing its file path");
    }
    const file = entry.file;
    if (Array.isArray(entry.files) && entry.files.length > 0) {
      for (const item of entry.files) {
        const name = nameOf(item);
        if (name === undefined) {
          throw new Error("knip report files issue carries no file name");
        }
        findings.push({ file, name });
      }
      continue;
    }
    for (const [key, value] of Object.entries(entry)) {
      if (!isFindingClass(key) || !Array.isArray(value)) continue;
      for (const item of value) {
        const name = nameOf(item);
        if (name === undefined) {
          throw new Error(`knip report ${key} issue carries no name`);
        }
        findings.push({ file, name });
      }
    }
  }
  return findings;
}

function nameOf(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const name = (item as KnipReportItem).name;
  return typeof name === "string" ? name : undefined;
}

// Passes only when nothing new died and no exemption is stale. Stale entries
// used to warn; now they fail so dead exemptions cannot linger.
export function isGuardPassing(outcome: GuardOutcome): boolean {
  return outcome.violations.length === 0 && outcome.unused.length === 0;
}

// knip's own binary shebang is node, but Bun spawns .bin targets with Bun —
// and knip's bun-mode path can behave differently across versions. The
// invocation is always launched with node and its flags are pinned here (the
// guard config carries no scan flags), so the report shape is stable and the
// scan cannot be narrowed side-channel.
export function knipSpawn(
  knipBinPath: string,
  args: readonly string[],
): {
  readonly command: string;
  readonly args: string[];
} {
  return { command: "node", args: [knipBinPath, ...args] };
}

// Both knip configs must exist: the default scan reads knip.json and the
// production agent scan reads the integrated-monorepo variant. A missing
// config silently narrows the scan, so the guard fails closed instead.
export function requireKnipConfigs(): void {
  for (const configPath of [join(repoRoot, "knip.json"), agentsConfigPath()]) {
    if (!existsSync(configPath)) {
      throw new Error(`knip config not found: ${configPath}`);
    }
  }
}

// The pinned base flags for every knip scan: JSON reporter, no progress
// output, and no exit-code clobbering (the guard owns the verdict; a knip
// process failure must surface as a guard failure, not as a finding count).
const knipBaseArgs = [
  "--reporter",
  "json",
  "--no-progress",
  "--no-exit-code",
] as const;

// The default scan covers every tree in knip.json's project scope. knip
// counts test-file imports as consumption, so an export whose only importers
// are tests is not reported here.
export function knipDefaultSpawn(knipBinPath: string): {
  readonly command: string;
  readonly args: string[];
} {
  return knipSpawn(knipBinPath, knipBaseArgs);
}

// The agent-workspace production scan is the test-laundering counterweight:
// knip's `--production` mode does not count test-file consumers, and the
// `-W agents/*` workspace filter keeps the pass scoped to the agent packages'
// entry-point surfaces the guard protects (the AGENTS.md director-extract
// bar). It runs the integrated-monorepo config (knip.agents.json, whose
// `workspaces` key makes cross-workspace consumers visible in production
// mode), so the registry fan-in still clears `director` while the laundered
// worker names surface. Outside that surface the default scan owns
// enforcement; the union of both scans is the guard's finding set.
export function knipAgentProductionSpawn(
  knipBinPath: string,
  workspaces: readonly string[],
): { readonly command: string; readonly args: string[] } {
  if (workspaces.length === 0) {
    throw new Error("agent-workspace production scan needs a workspace list");
  }
  return knipSpawn(knipBinPath, [
    "-c",
    agentsConfigPath(),
    "--production",
    ...knipBaseArgs,
    ...workspaces.flatMap((workspace) => ["-W", workspace]),
  ]);
}

// The agent workspaces the production scan must cover, derived from the
// allowlist's `agents/<id>/src/index.ts` entries so the scan stays pinned to
// the surface the allowlist governs. Fails closed when the surface names no
// workspace: a silent no-op scan cannot be trusted.
export function agentWorkspaceIds(rules: readonly AllowRule[]): string[] {
  const ids = new Set<string>();
  for (const rule of rules) {
    if (rule.kind === "exact" && rule.file.startsWith("agents/")) {
      const id = rule.file.slice("agents/".length).split("/")[0];
      if (id !== undefined && id !== "") ids.add(`agents/${id}`);
    }
  }
  const sorted = [...ids].sort();
  if (sorted.length === 0) {
    throw new Error(
      "dead-export allowlist names no agents/<id>/src/index.ts surface: " +
        "the agent-workspace production scan has nothing to cover",
    );
  }
  return sorted;
}

export function evaluateGuard(
  rules: AllowRule[],
  findings: readonly DeadExport[],
): GuardOutcome {
  const used = new Set<number>();
  const violations: string[] = [];
  for (const finding of findings) {
    const index = rules.findIndex((rule) =>
      rule.kind === "prefix"
        ? finding.file.startsWith(rule.prefix)
        : rule.file === finding.file && rule.name === finding.name,
    );
    if (index === -1) {
      violations.push(`${finding.file}: ${finding.name}`);
    } else {
      used.add(index);
    }
  }
  const unused = rules
    .filter((_, index) => !used.has(index))
    .map((r) => r.source);
  // Deterministic output ordering does not depend on knip's report order.
  return {
    dead: findings.length,
    violations: violations.sort(),
    unused: unused.sort(),
  };
}

// Undefined means compute the count as usual; anything else must be a
// positive integer or the gate fails closed rather than trusting it.
export function parseInjectedScannedFiles(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${scannedFilesEnv} must be a positive integer when set (test injection only)`,
    );
  }
  return parsed;
}

// Counts the TS files the pinned tsconfig pulls into its program via
// tsc --listFilesOnly. A narrowed tsconfig shrinks this count, and the gate
// fails closed against the checked-in floor. knip's own scan scope is pinned
// by knip.json; this floor is the repo-wide sanity check on the project
// graph that gate tooling parses against.
export function countScannedFiles(
  repoRootDir: string,
  tsconfigPath: string,
): number {
  const ran = spawnSync(tscBin, ["-p", tsconfigPath, "--listFilesOnly"], {
    cwd: repoRootDir,
    encoding: "utf8",
  });
  if (ran.error !== undefined) {
    throw new Error(`tsc --listFilesOnly failed to start: ${ran.error}`);
  }
  const roots = [repoRootDir, realpathSync(repoRootDir)];
  let count = 0;
  for (const raw of String(ran.stdout).split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (!line.endsWith(".ts") && !line.endsWith(".tsx")) continue;
    if (line.includes(`${sep}node_modules${sep}`)) continue;
    if (!roots.some((root) => line.startsWith(root + sep))) continue;
    count += 1;
  }
  return count;
}

export function isCoverageEnough(scannedFiles: number, floor: number): boolean {
  return scannedFiles >= floor;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// The guard's finding set is the union of two knip reports:
//
// 1. the default scan over knip.json's project scope, and
// 2. the `--production` scan filtered to the agent workspaces, where knip
//    does not count test-file consumers.
//
// Both run under the pinned spawn contract; a failing or malformed
// report fails the gate rather than narrowing it silently.
export function runKnipScans(rules: readonly AllowRule[]): DeadExport[] {
  requireKnipConfigs();
  const merge = (reports: readonly DeadExport[]): DeadExport[] => {
    const seen = new Set<string>();
    const merged: DeadExport[] = [];
    for (const finding of reports) {
      const key = `${finding.file}::${finding.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(finding);
    }
    return merged;
  };
  const spawnAndParse = (
    spawn: { readonly command: string; readonly args: string[] },
    label: string,
  ): DeadExport[] => {
    const ran = spawnSync(spawn.command, spawn.args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (ran.error !== undefined) {
      fail(
        `${label} failed to start with ${spawn.command}: ${ran.error.message}`,
      );
    }
    if (ran.status !== 0) {
      fail(`${label} failed:\n${ran.stderr || ran.stdout}`);
    }
    try {
      return parseKnipReport(String(ran.stdout));
    } catch (err) {
      fail(`${label} report unusable: ${(err as Error).message}`);
    }
  };
  const defaultFindings = spawnAndParse(
    knipDefaultSpawn(knipBin),
    "knip default scan",
  );
  const agentWorkspaces = agentWorkspaceIds(rules);
  const agentFindings = spawnAndParse(
    knipAgentProductionSpawn(knipBin, agentWorkspaces),
    "knip production agent scan",
  );
  return merge([...defaultFindings, ...agentFindings]);
}

function main(): void {
  let config: GuardConfig;
  try {
    config = loadGuardConfig();
  } catch (err) {
    fail(`dead-export guard: invalid guard config: ${(err as Error).message}`);
  }
  const allowlistText = readFileSync(allowlistPath, "utf8");
  const allowlistProblems = [
    ...validateAllowlistText(allowlistText),
    ...validateAllowlistOwnership(allowlistText),
  ];
  if (allowlistProblems.length > 0) {
    fail(
      "Invalid allowlist entries (fix the shape or remove them):\n" +
        allowlistProblems.map((problem) => `  ${problem}`).join("\n"),
    );
  }
  const rules = parseAllowlistText(allowlistText);
  const findings = runKnipScans(rules);
  const outcome = evaluateGuard(rules, findings);
  let scannedFiles: number;
  const injectedCount = parseInjectedScannedFiles(process.env[scannedFilesEnv]);
  if (injectedCount !== undefined) {
    scannedFiles = injectedCount;
  } else {
    try {
      scannedFiles = countScannedFiles(repoRoot, config.tsconfig);
    } catch (err) {
      fail(
        `dead-export guard: could not count scanned files: ${(err as Error).message}`,
      );
    }
  }
  console.log(
    `dead-export guard: ${outcome.dead} consumer-less exports or unreachable files (default scan + production agent-workspace scan), ${outcome.dead - outcome.violations.length} allowlisted, ${outcome.violations.length} violations, ${scannedFiles} scanned files (floor ${config.minScannedFiles})`,
  );
  if (!isCoverageEnough(scannedFiles, config.minScannedFiles)) {
    fail(
      `dead-export guard: scanned file count ${scannedFiles} is below the floor ${config.minScannedFiles} ` +
        "(the scan narrowed; fix the tsconfig or update scripts/dead-export-guard.json)",
    );
  }
  if (outcome.unused.length > 0) {
    console.error(
      "Stale allowlist entries matching no knip finding (remove them):\n" +
        outcome.unused.map((entry) => `  ${entry}`).join("\n"),
    );
  }
  if (outcome.violations.length > 0) {
    console.error(
      "New dead exports (delete them or justify an allowlist entry):\n" +
        outcome.violations.map((v) => `  ${v}`).join("\n"),
    );
  }
  if (!isGuardPassing(outcome)) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
