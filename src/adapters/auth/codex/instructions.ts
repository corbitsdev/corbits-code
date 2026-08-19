import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GPT_5_CODEX_PROMPT } from "./prompts/gpt-5-codex.js";
import { SETTINGS_DIR_NAME } from "../../../branding.js";

// The Codex backend pins the Responses `instructions` field to the official
// prompt and 400s on anything else, so a stale bundled copy breaks once the
// upstream prompt changes. We fetch the prompt for the latest openai/codex
// release, cache it on disk, and fall back to the disk cache then the bundled
// copy. Every value — disk and network — is validated before use so a CDN error
// page (served with HTTP 200) can never poison the cache into a permanent 400.

const CACHE_DIR = join(homedir(), SETTINGS_DIR_NAME, "cache");
const CACHE_FILE = join(CACHE_DIR, "gpt-5-codex-instructions.md");
const RELEASES_LATEST = "https://api.github.com/repos/openai/codex/releases/latest";
const PROMPT_PATH = "codex-rs/core/gpt_5_codex_prompt.md";

const PROMPT_SENTINEL = "You are Codex";
const MIN_PROMPT_LENGTH = 1000;

export function isValidCodexPrompt(text: string): boolean {
  return text.length >= MIN_PROMPT_LENGTH && text.startsWith(PROMPT_SENTINEL);
}

function loadCached(): string {
  try {
    const text = readFileSync(CACHE_FILE, "utf8");
    if (isValidCodexPrompt(text)) return text;
  } catch {
    // no cache yet, or unreadable — fall through to the bundled copy
  }
  return GPT_5_CODEX_PROMPT;
}

// Resolved lazily on first use so importing this module never blocks the event
// loop on a disk read during startup.
let instructions: string | undefined;

export function codexInstructions(): string {
  if (instructions === undefined) instructions = loadCached();
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
  const res = await fetch(`https://raw.githubusercontent.com/openai/codex/${encodeURIComponent(tag)}/${PROMPT_PATH}`);
  if (!res.ok) throw new Error(`Codex prompt fetch failed (HTTP ${String(res.status)}).`);
  const text = await res.text();
  if (!isValidCodexPrompt(text)) throw new Error("Codex prompt fetch returned an unexpected body.");
  if (text === instructions) return;
  instructions = text;
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, text, "utf8");
}
