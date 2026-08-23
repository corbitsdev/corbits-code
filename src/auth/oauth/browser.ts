import { spawn } from "node:child_process";
import { platform } from "node:os";

// Best-effort: open the authorization URL in the user's default browser. Never
// throws — a headless box or missing opener just means the user opens the
// surfaced link manually. Detached + unref so the opener cannot keep the
// process alive.
export function openInBrowser(url: string): void {
  const command = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Opening the browser is a convenience; the copyable link is the fallback.
  }
}
