import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Dead-export guard (CL-6797, hardened CL-7993): runs ts-prune over the project
// and fails when any export with no consumer falls outside
// scripts/dead-export-allowlist.txt. Exports used only inside their own module
// ("(used in module)") are live enough and do not count. New dead exports must
// be deleted, not allowlisted: the allowlist covers entry points, cross-lane
// ownership, plugin surfaces loaded by path, and ts-prune parser false
// positives only.
//
// Hardening: stale allowlist entries fail the gate instead of warning, every
// entry must pass shape validation and sit under a reason comment (the gate
// enforces the reason's presence; review enforces the owning lane — this repo
// has no CODEOWNERS, so the allowlist header documents the review convention),
// the ts-prune invocation is pinned to scripts/dead-export-guard.json, and the
// gate fails closed when the scanned file count drops below that config's
// floor.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const allowlistPath = join(here, "dead-export-allowlist.txt");
const guardConfigPath = join(here, "dead-export-guard.json");
const tsPruneBin = join(repoRoot, "node_modules", ".bin", "ts-prune");
const tscBin = join(repoRoot, "node_modules", "typescript", "bin", "tsc");

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
  readonly tsPruneArgs: readonly string[];
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

// Rejects a single allowlist line that the matcher would silently
// misinterpret: a mistyped exact entry ("file: bad name!") must not decay into
// a prefix that matches nothing, and a directory without a trailing slash
// ("vendor") must not pass as an imprecise prefix. Only `dir/` prefixes and
// repo-relative `.ts` paths (bare or `file: Name`) are valid.
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

// Every entry must sit under a reason comment in the same blank-line section
// and above the entry. The gate enforces the reason's presence; human review
// enforces that it names the owning lane. A section of entries with no reason
// above it fails, so exemptions cannot land without a reason on record.
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

// Parses and validates the pinned scan config. The invocation must be exactly
// "-p <tsconfig>" and nothing else, so narrowing flags (e.g. "-i"/"--ignore")
// cannot shrink the scan while the tsc --listFilesOnly file count stays flat.
// The floor must be a positive integer the gate fails closed against.
export function parseGuardConfig(raw: unknown): GuardConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("dead-export guard config must be a JSON object");
  }
  const config = raw as Record<string, unknown>;
  const tsconfig = config["tsconfig"];
  if (typeof tsconfig !== "string" || tsconfig === "") {
    throw new Error('dead-export guard config needs a "tsconfig" path string');
  }
  const tsPruneArgs = config["tsPruneArgs"];
  if (
    !Array.isArray(tsPruneArgs) ||
    tsPruneArgs.length === 0 ||
    tsPruneArgs.some((arg) => typeof arg !== "string")
  ) {
    throw new Error(
      'dead-export guard config needs a non-empty "tsPruneArgs" string array',
    );
  }
  const args = tsPruneArgs as string[];
  if (args.length !== 2 || args[0] !== "-p" || args[1] !== tsconfig) {
    throw new Error(
      'dead-export guard config "tsPruneArgs" must be exactly ["-p", "<tsconfig>"] with no extra flags',
    );
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
  return { tsconfig, tsPruneArgs: [...args], minScannedFiles };
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

// Parses one ts-prune output line. Returns undefined for blank lines,
// unparseable lines, and exports used only inside their own module.
export function parseTsPruneLine(raw: string): DeadExport | undefined {
  const match = raw.match(/^(.*?):\d+ - (\S+?)(\s+\(used in module\))?$/);
  if (!match) return undefined;
  if (match[3] !== undefined) return undefined;
  const file = match[1];
  const name = match[2];
  if (file === undefined || name === undefined) return undefined;
  return { file, name };
}

export function evaluateGuard(
  rules: AllowRule[],
  tsPruneStdout: string,
): GuardOutcome {
  const used = new Set<number>();
  const violations: string[] = [];
  let dead = 0;
  for (const raw of tsPruneStdout.split("\n")) {
    const parsed = parseTsPruneLine(raw);
    if (parsed === undefined) continue;
    dead += 1;
    const index = rules.findIndex((rule) =>
      rule.kind === "prefix"
        ? parsed.file.startsWith(rule.prefix)
        : rule.file === parsed.file && rule.name === parsed.name,
    );
    if (index === -1) {
      violations.push(`${parsed.file}: ${parsed.name}`);
    } else {
      used.add(index);
    }
  }
  const unused = rules
    .filter((_, index) => !used.has(index))
    .map((r) => r.source);
  return { dead, violations, unused };
}

// The gate passes only when nothing new died and no exemption is stale.
// Stale entries fail (they used to warn) so dead exemptions cannot linger
// after the code they cover is gone.
export function isGuardPassing(outcome: GuardOutcome): boolean {
  return outcome.violations.length === 0 && outcome.unused.length === 0;
}

// Counts the TypeScript files the pinned tsconfig pulls into its program via
// tsc --listFilesOnly: the same project ts-prune analyzes. A narrowed
// tsconfig (or a moved scan root) shrinks this count, and the gate fails
// closed against the checked-in floor instead of green-lighting a scan that
// looked at less code.
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
  const pruned = spawnSync(tsPruneBin, [...config.tsPruneArgs], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (pruned.status !== 0) {
    fail(`ts-prune failed:\n${pruned.stderr || pruned.stdout}`);
  }
  const outcome = evaluateGuard(rules, String(pruned.stdout));
  let scannedFiles: number;
  try {
    scannedFiles = countScannedFiles(repoRoot, config.tsconfig);
  } catch (err) {
    fail(
      `dead-export guard: could not count scanned files: ${(err as Error).message}`,
    );
  }
  console.log(
    `dead-export guard: ${outcome.dead} consumer-less exports, ${outcome.dead - outcome.violations.length} allowlisted, ${outcome.violations.length} violations, ${scannedFiles} scanned files (floor ${config.minScannedFiles})`,
  );
  if (!isCoverageEnough(scannedFiles, config.minScannedFiles)) {
    fail(
      `dead-export guard: scanned file count ${scannedFiles} is below the floor ${config.minScannedFiles} ` +
        "(the scan narrowed; fix the tsconfig or update scripts/dead-export-guard.json)",
    );
  }
  if (outcome.unused.length > 0) {
    console.error(
      "Stale allowlist entries matching no dead export (remove them):\n" +
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
