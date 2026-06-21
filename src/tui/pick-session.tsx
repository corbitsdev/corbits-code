import { render } from "ink";

import { listSessions, type SessionSummary } from "../session/index.js";
import { SessionResumePicker } from "./components/session-resume-picker.js";

export async function pickSession(cwd: string): Promise<SessionSummary | null> {
  const sessions = await listSessions(cwd);
  if (sessions.length === 0) {
    process.stderr.write("intercode: no previous sessions found in this directory.\n");
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
    void waitUntilExit().then(() => settle(null));
  });
}