import {
  loadSettings,
  saveGlobalSettings,
  type Settings,
} from "../config/settings.js";
import type { SessionMode } from "../config/session-mode.js";
import { COMMAND_NAME } from "../branding.js";
import { runListModal } from "../tui-opentui/list-modal.js";

const OPTIONS: readonly { mode: SessionMode; title: string; description: string }[] = [
  {
    mode: "single",
    title: "Single agent",
    description:
      "one agent edits, runs commands, and answers directly; sub-agents off",
  },
  {
    mode: "orchestrator",
    title: "Orchestrator",
    description:
      "top-level agent delegates via task, manages parallel workers, synthesizes reports",
  },
];

function isSessionMode(value: string): value is SessionMode {
  return OPTIONS.some((option) => option.mode === value);
}

export async function promptSessionModeIfUnset(
  globalSettingsPath: string,
): Promise<SessionMode | undefined> {
  const existing = await loadSettings(globalSettingsPath);
  if (existing?.sessionMode !== undefined) return existing.sessionMode;

  const picked = await runListModal({
    title: "Session mode",
    kind: "settings",
    heading: [
      "Choose how the primary session behaves.",
      "Change it later in Settings or via sessionMode in global settings.",
    ],
    options: OPTIONS.map((option) => ({
      id: option.mode,
      label: `${option.title} — ${option.description}`,
    })),
  });

  if (picked === null || !isSessionMode(picked)) return undefined;

  const base: Settings = existing ?? { providers: {} };
  try {
    await saveGlobalSettings(globalSettingsPath, { ...base, sessionMode: picked });
  } catch (err) {
    // The choice is unusable if it cannot be persisted; fall back to the
    // unset path so the next launch asks again.
    process.stderr.write(
      `${COMMAND_NAME}: could not save session mode: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  }
  return picked;
}
