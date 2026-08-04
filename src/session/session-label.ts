import { loadSentMessages } from "./sent-messages.js";

const GENERIC_TASKS = new Set(["", "(conversation)", "(no task title)", "Untitled session"]);

export function truncateSessionLabel(text: string, max = 72): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export function isGenericSessionTask(task: string): boolean {
  return GENERIC_TASKS.has(task.trim());
}

/** Human-readable session title for lists and the resume picker. */
export async function resolveSessionLabel(
  cwd: string,
  sessionId: string,
  taskFromState: string,
  home?: string,
): Promise<string> {
  const trimmed = taskFromState.trim();
  if (!isGenericSessionTask(trimmed)) {
    return truncateSessionLabel(trimmed);
  }
  const sent = await loadSentMessages(cwd, sessionId, home);
  const first = sent.find((line) => line.trim().length > 0);
  if (first !== undefined) {
    return truncateSessionLabel(first);
  }
  return "Untitled session";
}
