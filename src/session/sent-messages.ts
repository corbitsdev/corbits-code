import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { type } from "arktype";

import { sessionDir } from "./index.js";

function sentMessagesPath(cwd: string, sessionId: string): string {
  return join(sessionDir(cwd, sessionId), "sent-messages.ndjson");
}

const sentMessage = type("string");

export async function loadSentMessages(cwd: string, sessionId: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(sentMessagesPath(cwd, sessionId), "utf8");
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const validated = sentMessage(parsed);
      if (!(validated instanceof type.errors)) results.push(validated);
    } catch {
      // corrupt line — skip
    }
  }
  return results;
}

// Append-only: no read-modify-write race. Each message is one JSON line.
export async function appendSentMessage(cwd: string, sessionId: string, message: string): Promise<void> {
  const trimmed = message.trim();
  if (trimmed.length === 0) return;
  await appendFile(sentMessagesPath(cwd, sessionId), JSON.stringify(trimmed) + "\n");
}
