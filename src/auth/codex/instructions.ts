import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GPT_5_CODEX_PROMPT } from "./prompts/gpt-5-codex.js";

// The Codex backend pins the Responses `instructions` field to the official
// prompt and 400s on anything else, so a stale bundled copy breaks once the
// upstream prompt changes. We fetch the prompt for the latest openai/codex
// release, cache it on disk, and fall back to the disk cache then the bundled
// copy when offline.

const CACHE_FILE = join(homedir(), ".intercode", "cache", "gpt-5-codex-instructions.md");
const RELEASES_LATEST = "https://api.github.com/repos/openai/codex/releases/latest";
const PROMPT_PATH = "codex-rs/core/gpt_5_codex_prompt.md";

function loadCached(): string {
  try {
    return readFileSync(CACHE_FILE, "utf8");
  } catch {
    return GPT_5_CODEX_PROMPT;
  }
}

let instructions = loadCached();

export function codexInstructions(): string {
  return instructions;
}

async function latestReleaseTag(): Promise<string> {
  const res = await fetch(RELEASES_LATEST, { headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`Codex release lookup failed (HTTP ${String(res.status)}).`);
  const data = (await res.json()) as { tag_name?: unknown };
  if (typeof data.tag_name !== "string") throw new Error("Codex release lookup returned no tag.");
  return data.tag_name;
}

export async function refreshCodexInstructions(): Promise<void> {
  const tag = await latestReleaseTag();
  const res = await fetch(`https://raw.githubusercontent.com/openai/codex/${tag}/${PROMPT_PATH}`);
  if (!res.ok) throw new Error(`Codex prompt fetch failed (HTTP ${String(res.status)}).`);
  const text = await res.text();
  if (text.length === 0 || text === instructions) return;
  instructions = text;
  mkdirSync(join(homedir(), ".intercode", "cache"), { recursive: true });
  writeFileSync(CACHE_FILE, text, "utf8");
}
