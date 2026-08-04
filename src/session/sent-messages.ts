import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { type } from "arktype";

import { sessionDir } from "./index.js";

/** Max user messages recallable with Up/Down in the prompt (newest retained). */
export const SENT_MESSAGE_HISTORY_LIMIT = 20;

// Only the last SENT_MESSAGE_HISTORY_LIMIT entries are ever returned, so we read
// just the file's tail rather than loading an unbounded history into memory.
// Generously sized for that many short prompts; a sliced-mid-line fragment at the
// head simply fails to parse and is skipped.
const TAIL_BYTES = 64_000;

function sentMessagesPath(cwd: string, sessionId: string, home?: string): string {
  return join(sessionDir(cwd, sessionId, home), "sent-messages.ndjson");
}


const sentMessage = type("string");

export async function loadSentMessages(
  cwd: string,
  sessionId: string,
  home?: string,
): Promise<string[]> {
  const file = Bun.file(sentMessagesPath(cwd, sessionId, home));

  let raw: string;
  try {
    const size = file.size;
    raw = size > TAIL_BYTES ? await file.slice(size - TAIL_BYTES).text() : await file.text();
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const results: string[] = [];
  for (const line of lines.slice(-SENT_MESSAGE_HISTORY_LIMIT)) {
    try {
      const parsed: unknown = JSON.parse(line);
      const validated = sentMessage(parsed);
      if (!(validated instanceof type.errors)) results.push(validated);
    } catch {
      // corrupt or partial line — skip
    }
  }
  return results;
}

// Append-only: no read-modify-write race. Each message is one JSON line.
export async function appendSentMessage(
  cwd: string,
  sessionId: string,
  message: string,
  home?: string,
): Promise<void> {
  const trimmed = message.trim();
  if (trimmed.length === 0) return;
  await appendFile(sentMessagesPath(cwd, sessionId, home), JSON.stringify(trimmed) + "\n");
}

