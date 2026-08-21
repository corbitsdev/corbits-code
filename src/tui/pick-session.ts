import { COMMAND_NAME } from "../branding.js";
import { listSessions, type SessionSummary } from "../session/index.js";
import { runListModal } from "./list-modal.js";
import { formatRelativeTime } from "./format-relative-time.js";

// Interrupted (cancelled) sessions are prime resume candidates alongside
// in-progress ones; only done/failed runs need --force to reopen.
export function isResumableByDefault(session: Pick<SessionSummary, "status">): boolean {
  return session.status === "running" || session.status === "cancelled";
}

export function sessionResumeLabel(session: SessionSummary): string {
  const title = session.task.trim().length > 0 ? session.task.trim() : "Untitled session";
  return `${title} · ${formatRelativeTime(session.startedAt)} · ${session.status}`;
}

export async function pickSession(
  cwd: string,
  options?: { includeCompleted?: boolean },
): Promise<SessionSummary | null> {
  let sessions = await listSessions(cwd);
  if (options?.includeCompleted !== true) {
    sessions = sessions.filter(isResumableByDefault);
  }
  if (sessions.length === 0) {
    process.stderr.write(
      options?.includeCompleted === true
        ? `${COMMAND_NAME}: no previous sessions found in this directory.\n`
        : `${COMMAND_NAME}: no in-progress sessions found (use --force to resume completed runs).\n`,
    );
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
