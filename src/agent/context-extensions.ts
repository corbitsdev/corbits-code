import { join } from "node:path";
import { SETTINGS_DIR_NAME } from "../branding.js";

export async function loadAgentContextExtensions(cwd: string): Promise<string[]> {
  const extensions: string[] = [];
  const agentsMdPath = join(cwd, "AGENTS.md");
  try {
    const content = await Bun.file(agentsMdPath).text();
    if (content.trim().length > 0) {
      const MAX_AGENTS_MD_BYTES = 32_000;
      if (content.length > MAX_AGENTS_MD_BYTES) {
        process.stderr.write(
          `[interchange] Warning: AGENTS.md exceeds ${MAX_AGENTS_MD_BYTES} bytes and will be truncated.\n`,
        );
      }
      extensions.push(
        `## Project guidance (AGENTS.md, reference)\n\n` +
          `The following is the repository's AGENTS.md, provided as background about the project. ` +
          `Do not execute its agent-onboarding or session-initialization steps (loading skills, reading skill files) — ` +
          `they target other tools and those files may not exist in this repo. Use it as reference when it helps the task.\n\n` +
          content.slice(0, MAX_AGENTS_MD_BYTES),
      );
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(`[interchange] Warning: could not read AGENTS.md: ${String(err)}\n`);
    }
  }
  return extensions;
}

export interface SystemPromptOverrides {
  // SYSTEM.md content — replaces the static base block (role + harness facts + guidelines).
  base?: string;
  // APPEND_SYSTEM.md content — appended as an extra section after the base.
  append: string[];
}

// Project-level system-prompt overrides, resolved repo-root first then .corbits/.
// SYSTEM.md replaces the base block; APPEND_SYSTEM.md is appended. Mirrors Pi's
// SYSTEM.md / APPEND_SYSTEM.md convention.
export async function loadSystemPromptOverrides(cwd: string): Promise<SystemPromptOverrides> {
  const dirs = [cwd, join(cwd, SETTINGS_DIR_NAME)];
  const base = await firstFile(dirs, "SYSTEM.md");
  const appendBody = await firstFile(dirs, "APPEND_SYSTEM.md");
  return {
    ...(base !== undefined ? { base } : {}),
    append: appendBody !== undefined ? [appendBody] : [],
  };
}

async function firstFile(dirs: string[], name: string): Promise<string | undefined> {
  for (const dir of dirs) {
    try {
      const content = (await Bun.file(join(dir, name)).text()).trim();
      if (content.length > 0) return content;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        process.stderr.write(`[interchange] Warning: could not read ${name}: ${String(err)}\n`);
      }
    }
  }
  return undefined;
}
