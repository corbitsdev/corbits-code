// Shared product-event emitters that every surface (TUI, exec, future
// headless) must call so dashboards are not silently TUI-only.

import type { Telemetry } from "./index.js";
import { classifyCommandName } from "./classify.js";

/** Emit slash_command with a classified first-party (or `custom`) name. */
export function captureSlashCommand(telemetry: Telemetry, commandName: string): void {
  telemetry.capture("slash_command", {
    command_name: classifyCommandName(commandName),
  });
}
