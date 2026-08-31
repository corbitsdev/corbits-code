import { COMMAND_NAME } from "../branding.js";
import { listSessions, type SessionSummary } from "../session/index.js";
import { runListModal } from "./list-modal.js";
import { formatRelativeTime } from "./format-relative-time.js";

export function sessionResumeLabel(session: SessionSummary): string {
  const title = session.task.trim().length > 0 ? session.task.trim() : "Untitled session";
  return `${title} · ${formatRelativeTime(session.updatedAt)} · ${session.status}`;
}

export async function pickSession(cwd: string): Promise<SessionSummary | null> {
  const sessions = await listSessions(cwd);
  if (sessions.length === 0) {
    process.stderr.write(`${COMMAND_NAME}: no previous sessions found in this directory.\n`);
    return null;
  }

  const picked = await runListModal({
    title: "Resume conversation",
    kind: "resume",
    heading: ["Choose a previous session in this checkout"],
    options: sessions.map((session) => ({
      id: session.sessionId,
      label: sessionResumeLabel(session),
    })),
  });

  if (picked === null) return null;
  return sessions.find((session) => session.sessionId === picked) ?? null;
}
