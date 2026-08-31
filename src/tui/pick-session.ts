import { COMMAND_NAME } from "../branding.js";
import { listSessions, type SessionSummary } from "../session/index.js";
import { runListModal } from "./list-modal.js";
import { formatRelativeTime } from "./format-relative-time.js";

export const RESUME_PICKER_LIMIT = 10;

export function sessionResumeLabel(session: SessionSummary): string {
  const title = session.task.trim().length > 0 ? session.task.trim() : "Untitled session";
  return `${title} · ${formatRelativeTime(session.updatedAt)} · ${session.status}`;
}

/** Newest-first catalog already sorted; keep the most recent `limit` rows. */
export function recentResumeSessions(
  sessions: readonly SessionSummary[],
  limit = RESUME_PICKER_LIMIT,
): SessionSummary[] {
  return sessions.slice(0, limit);
}

export async function pickSession(cwd: string): Promise<SessionSummary | null> {
  const catalog = await listSessions(cwd);
  if (catalog.length === 0) {
    process.stderr.write(`${COMMAND_NAME}: no previous sessions found in this directory.\n`);
    return null;
  }

  const sessions = recentResumeSessions(catalog);
  const picked = await runListModal({
    title: "Resume conversation",
    kind: "resume",
    heading: ["Choose a previous session in this checkout"],
    typeToFilter: true,
    options: sessions.map((session) => ({
      id: session.sessionId,
      label: sessionResumeLabel(session),
    })),
  });

  if (picked === null) return null;
  return sessions.find((session) => session.sessionId === picked) ?? null;
}
