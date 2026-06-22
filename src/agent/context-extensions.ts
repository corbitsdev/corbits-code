import { join } from "node:path";

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