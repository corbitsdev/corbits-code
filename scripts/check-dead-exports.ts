import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Dead-export guard (CL-6797): runs ts-prune over the project and fails when
// any export with no consumer falls outside scripts/dead-export-allowlist.txt.
// Exports used only inside their own module ("(used in module)") are live
// enough and do not count. New dead exports must be deleted, not allowlisted:
// the allowlist covers entry points, cross-lane ownership, plugin surfaces
// loaded by path, and ts-prune parser false positives only.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const allowlistPath = join(here, "dead-export-allowlist.txt");
const tsPruneBin = join(repoRoot, "node_modules", ".bin", "ts-prune");

type AllowRule =
  | { readonly kind: "prefix"; readonly prefix: string }
  | { readonly kind: "exact"; readonly file: string; readonly name: string };

function loadAllowlist(): AllowRule[] {
  const rules: AllowRule[] = [];
  for (const raw of readFileSync(allowlistPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const exact = line.match(/^(.+?): ([A-Za-z_$][\w$]*)$/);
    if (exact) {
      const file = exact[1];
      const name = exact[2];
      if (file !== undefined && name !== undefined) {
        rules.push({ kind: "exact", file: file.trim(), name: name.trim() });
      }
    } else {
      rules.push({ kind: "prefix", prefix: line });
    }
  }
  return rules;
}

function isAllowlisted(
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

function main(): void {
  const rules = loadAllowlist();
  const pruned = spawnSync(tsPruneBin, [], { cwd: repoRoot, encoding: "utf8" });
  if (pruned.status !== 0) {
    console.error(`ts-prune failed:\n${pruned.stderr || pruned.stdout}`);
    process.exit(1);
  }
  const violations: string[] = [];
  let dead = 0;
  for (const raw of String(pruned.stdout).split("\n")) {
    const match = raw.match(/^(.*?):\d+ - (\S+?)(\s+\(used in module\))?$/);
    if (!match) continue;
    if (match[3] !== undefined) continue;
    const file = match[1];
    const name = match[2];
    if (file === undefined || name === undefined) continue;
    dead += 1;
    if (!isAllowlisted(rules, file, name)) violations.push(`${file}: ${name}`);
  }
  console.log(
    `dead-export guard: ${dead} consumer-less exports, ${dead - violations.length} allowlisted, ${violations.length} violations`,
  );
  if (violations.length > 0) {
    console.error(
      "New dead exports (delete them or justify an allowlist entry):\n" +
        violations.map((v) => `  ${v}`).join("\n"),
    );
    process.exit(1);
  }
}

main();
