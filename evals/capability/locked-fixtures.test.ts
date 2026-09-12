import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalCases, resolveFixturePath } from "./lib.js";

const capabilityDir = dirname(fileURLToPath(import.meta.url));

function parseLockedContract(
  verifySrc: string,
  caseId: string,
): { sha: string; path: string } | null {
  const sha = verifySrc.match(/^TEST_SHA="([0-9a-f]{64})"$/m)?.[1];
  if (sha === undefined) return null;
  const hashed = verifySrc.match(/shasum -a 256 (\S+)/)?.[1];
  const guarded = [...verifySrc.matchAll(/\[\[ -f (\S+) \]\]/g)].map(
    (m) => m[1],
  );
  if (hashed === undefined || !guarded.includes(hashed)) {
    throw new Error(
      `case ${caseId}: cannot determine the locked contract file from verify.sh`,
    );
  }
  return { sha, path: hashed };
}

describe("locked fixture hashes", () => {
  test("every TEST_SHA literal matches its fixture file", async () => {
    const repoRoot = resolve(capabilityDir, "..", "..");
    const cases = await loadEvalCases(join(capabilityDir, "cases"));
    const failures: string[] = [];
    let checked = 0;
    for (const c of cases) {
      const verifySrc = await readFile(join(c.caseDir, c.verify), "utf8");
      const locked = parseLockedContract(verifySrc, c.id);
      if (locked === null) continue;
      checked += 1;
      const bytes = await readFile(
        join(resolveFixturePath(repoRoot, c.fixture), locked.path),
      );
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== locked.sha) {
        failures.push(
          `case ${c.id}: ${locked.path} hashes to ${actual} but verify.sh pins ${locked.sha}`,
        );
      }
    }
    expect(checked).toBeGreaterThan(0);
    if (failures.length > 0) {
      throw new Error(`stale locked hashes:\n${failures.join("\n")}`);
    }
  });
});
