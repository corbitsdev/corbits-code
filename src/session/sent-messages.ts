import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { atomicWrite } from "./state.js";
import { sessionDir } from "./index.js";

function sentMessagesPath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), "sent-messages.json");
}

function isStringArray(data: unknown): data is string[] {
  return Array.isArray(data) && data.every((item) => typeof item === "string");
}

export async function loadSentMessages(cwd: string, sessionId: string): Promise<string[]> {
  try {
    const raw = await readFile(sentMessagesPath(cwd, sessionId), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isStringArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function appendSentMessage(cwd: string, sessionId: string, message: string): Promise<void> {
  const trimmed = message.trim();
  if (trimmed.length === 0) return;
  const existing = await loadSentMessages(cwd, sessionId);
  existing.push(trimmed);
  await atomicWrite(sentMessagesPath(cwd, sessionId), JSON.stringify(existing, null, 2));
}