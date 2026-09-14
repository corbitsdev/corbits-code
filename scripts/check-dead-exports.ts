import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Dead-export guard (CL-6797): runs ts-prune over the project and fails when
// any export with no consumer falls outside scripts/dead-export-allowlist.txt.
// Exports used only inside their own module ("(used in module)") are live
// enough and do not count. New dead exports must be deleted, not allowlisted:
// the allowlist covers entry points, cross-lane ownership, plugin surfaces
// loaded by path, and ts-prune parser false positives only. Allowlist entries
// that match no current ts-prune flag are reported as stale warnings so dead
// exemptions cannot linger after the code they cover is gone.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const allowlistPath = join(here, "dead-export-allowlist.txt");
const tsPruneBin = join(repoRoot, "node_modules", ".bin", "ts-prune");

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

export function parseAllowlistText(text: string): AllowRule[] {
  const rules: AllowRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const exact = line.match(/^(.+?): ([A-Za-z_$][\w$]*)$/);
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

export function loadAllowlist(): AllowRule[] {
  return parseAllowlistText(readFileSync(allowlistPath, "utf8"));
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

function main(): void {
  const rules = loadAllowlist();
  const pruned = spawnSync(tsPruneBin, [], { cwd: repoRoot, encoding: "utf8" });
  if (pruned.status !== 0) {
    console.error(`ts-prune failed:\n${pruned.stderr || pruned.stdout}`);
    process.exit(1);
  }
  const outcome = evaluateGuard(rules, String(pruned.stdout));
  console.log(
    `dead-export guard: ${outcome.dead} consumer-less exports, ${outcome.dead - outcome.violations.length} allowlisted, ${outcome.violations.length} violations`,
  );
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
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
