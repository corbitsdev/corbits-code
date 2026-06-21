import { render } from "ink";

import { listSessions, type SessionSummary } from "../session/index.js";
import { SessionResumePicker } from "./components/session-resume-picker.js";

export async function pickSession(
  cwd: string,
  options?: { includeCompleted?: boolean },
): Promise<SessionSummary | null> {
  let sessions = await listSessions(cwd);
  if (options?.includeCompleted !== true) {
    sessions = sessions.filter((s) => s.status === "running");
  }
  if (sessions.length === 0) {
    process.stderr.write(
      options?.includeCompleted === true
        ? "intercode: no previous sessions found in this directory.\n"
        : "intercode: no in-progress sessions found (use --force to resume completed runs).\n",
    );
    return null;
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: SessionSummary | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const { waitUntilExit } = render(
      <SessionResumePicker
        sessions={sessions}
        onSelect={(session) => settle(session)}
        onCancel={() => settle(null)}
      />,
      { exitOnCtrlC: true },
    );
    void waitUntilExit().then(() => {
      // Only treat as cancel when the user did not already select a session.
      settle(null);
    });
  });
}