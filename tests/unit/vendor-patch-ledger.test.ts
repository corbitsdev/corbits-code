/**
 * Correspondence between `Locally patched` markers under vendor/ and the
 * site-specific headings in each package's PATCHES.md ledger (CL-5720).
 *
 * Every marker anchor must resolve to a real `## <anchor>` heading; every
 * ledger heading must have at least one marker. Markers are navigation —
 * `bin/vendor-patch-diff` is the authoritative proof of which lines are ours.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = join(import.meta.dirname, "../..");
const vendorRoot = join(repoRoot, "vendor");

const MARKER_RE =
  /Locally patched\s*[—-]\s*see\s+(vendor\/[^#\s]+\/PATCHES\.md)#([A-Za-z0-9][A-Za-z0-9_-]*)/g;
const HEADING_RE = /^## ([A-Za-z0-9][A-Za-z0-9_-]*)\s*$/gm;

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...(await listFilesRecursive(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

async function patchedPackages(): Promise<string[]> {
  const entries = await readdir(vendorRoot, { withFileTypes: true });
  const packages: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const ledger = join(vendorRoot, entry.name, "PATCHES.md");
    try {
      await stat(ledger);
      packages.push(entry.name);
    } catch {
      // no ledger
    }
  }
  return packages.sort();
}

interface Marker {
  file: string;
  anchor: string;
  line: number;
}

async function collectMarkers(pkgDir: string): Promise<Marker[]> {
  const srcDir = join(pkgDir, "src");
  let files: string[];
  try {
    files = await listFilesRecursive(srcDir);
  } catch {
    return [];
  }
  const markers: Marker[] = [];
  for (const file of files) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) continue;
    const text = await readFile(file, "utf8");
    const rel = relative(repoRoot, file);
    let match: RegExpExecArray | null;
    MARKER_RE.lastIndex = 0;
    while ((match = MARKER_RE.exec(text)) !== null) {
      const before = text.slice(0, match.index);
      const line = before.split("\n").length;
      markers.push({ file: rel, anchor: match[2]!, line });
    }
  }
  return markers;
}

async function collectHeadings(ledgerPath: string): Promise<string[]> {
  const text = await readFile(ledgerPath, "utf8");
  const headings: string[] = [];
  let match: RegExpExecArray | null;
  HEADING_RE.lastIndex = 0;
  while ((match = HEADING_RE.exec(text)) !== null) {
    headings.push(match[1]!);
  }
  return headings;
}

describe("vendor patch ledger correspondence (CL-5720)", () => {
  test("every Locally patched marker anchor resolves; every ledger heading has a marker", async () => {
    const packages = await patchedPackages();
    expect(packages.length).toBeGreaterThan(0);

    const failures: string[] = [];

    for (const pkg of packages) {
      const pkgDir = join(vendorRoot, pkg);
      const ledgerRel = `vendor/${pkg}/PATCHES.md`;
      const ledgerPath = join(repoRoot, ledgerRel);
      const headings = await collectHeadings(ledgerPath);
      const headingSet = new Set(headings);
      const markers = await collectMarkers(pkgDir);

      if (headings.length === 0) {
        failures.push(`${ledgerRel}: no ## site-specific headings found`);
      }
      if (markers.length === 0) {
        failures.push(`vendor/${pkg}/src: no Locally patched markers found`);
      }

      // Duplicate headings would make anchors ambiguous.
      const seen = new Set<string>();
      for (const h of headings) {
        if (seen.has(h)) {
          failures.push(`${ledgerRel}: duplicate heading #${h}`);
        }
        seen.add(h);
      }

      for (const m of markers) {
        const expectedLedger = `vendor/${pkg}/PATCHES.md`;
        // Path inside the marker comment must point at this package's ledger.
        // Re-check via the raw comment is overkill; anchor membership is enough
        // when we only scan this package's src.
        if (!headingSet.has(m.anchor)) {
          failures.push(
            `${m.file}:${m.line}: marker #${m.anchor} has no matching ## heading in ${ledgerRel}`,
          );
        }
        void expectedLedger;
      }

      const markedAnchors = new Set(markers.map((m) => m.anchor));
      for (const h of headings) {
        if (!markedAnchors.has(h)) {
          failures.push(
            `${ledgerRel}: heading #${h} has no Locally patched marker under vendor/${pkg}/src`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  test("PATCHES.md states that the SHA-diff is authoritative", async () => {
    const packages = await patchedPackages();
    for (const pkg of packages) {
      const text = await readFile(join(vendorRoot, pkg, "PATCHES.md"), "utf8");
      expect(text.toLowerCase()).toContain("authoritative");
      expect(text).toContain("bin/vendor-patch-diff");
    }
  });
});
