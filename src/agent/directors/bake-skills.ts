import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Strip leading YAML frontmatter from a SKILL.md body (same shape as
 * resolveSkillBody / splitFrontmatter — keep sync and dependency-light so
 * director prompt assembly stays sync).
 */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw.trim();
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw.trim();
  return raw.slice(end + 4).trim();
}

/**
 * Candidate roots for first-party corbits-skills, covering source tree,
 * bun-bundled dist/, and compiled binary layouts. Keep this self-contained —
 * do not import plugins/loader (circular: loader → trust → … → directors).
 */
function skillsRootCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const out: string[] = [];
  // Source: src/agent/directors → ../../../plugins/corbits-skills/skills
  out.push(join(here, "..", "..", "..", "plugins", "corbits-skills", "skills"));
  // Bundled: dist/index.js (or chunk) → dist/plugins/corbits-skills/skills
  out.push(join(here, "plugins", "corbits-skills", "skills"));
  // Compiled binary: plugins next to execPath
  if (process.execPath.length > 0) {
    out.push(join(dirname(process.execPath), "plugins", "corbits-skills", "skills"));
  }
  return out;
}

function resolveSkillsRoot(): string | undefined {
  for (const dir of skillsRootCandidates()) {
    if (existsSync(dir)) return dir;
  }
  return undefined;
}

const bodyCache = new Map<string, string | undefined>();

/**
 * Load a first-party corbits-skills body by directory name (e.g. "style").
 */
export function loadBakedSkillBody(name: string): string | undefined {
  if (bodyCache.has(name)) return bodyCache.get(name);

  const root = resolveSkillsRoot();
  if (root === undefined) {
    bodyCache.set(name, undefined);
    return undefined;
  }

  try {
    const raw = readFileSync(join(root, name, "SKILL.md"), "utf8");
    const body = stripFrontmatter(raw);
    const value = body.length > 0 ? body : undefined;
    bodyCache.set(name, value);
    return value;
  } catch {
    bodyCache.set(name, undefined);
    return undefined;
  }
}

/**
 * Append-ready markdown for optionalSkills bodies. Empty string when none
 * resolve (missing catalog must not invent content or advertise a bake).
 * Only include bodies that actually loaded — do not claim "full" coverage
 * when some names miss.
 */
export function formatBakedOptionalSkills(names: readonly string[]): string {
  const sections: string[] = [];
  for (const name of names) {
    const body = loadBakedSkillBody(name);
    if (body === undefined) continue;
    sections.push(`### ${name}\n\n${body}`);
  }
  if (sections.length === 0) return "";
  return (
    "\n\n# Baked skill guidance\n\n" +
    "use_skill is not mounted on workers. Resolved skill bodies for this package follow.\n\n" +
    sections.join("\n\n")
  );
}
