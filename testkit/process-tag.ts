import { spawnSync } from "node:child_process";

/**
 * Bounded pgrep waits for tests that spawn tagged children and must observe
 * their real process-tree lifecycle. The pgrep loop is the only way to see a
 * process the plugin spawned outside the test's hands; keep the waits
 * explicit here instead of re-rolling per test file.
 */

function taggedPids(token: string): string {
  const probe = spawnSync("pgrep", ["-f", token], { encoding: "utf8" });
  return probe.stdout?.trim() ?? "";
}

/** Resolves once any process matches `token`; rejects after `timeoutMs`. */
export async function waitUntilTagged(
  token: string,
  timeoutMs = 5_000,
  intervalMs = 50,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (taggedPids(token).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`tagged child did not appear after ${timeoutMs}ms: ${token}`);
}

/** Resolves once no process matches `token`; returns the last observed ids. */
export async function waitUntilGone(
  token: string,
  timeoutMs = 5_000,
  intervalMs = 50,
): Promise<string> {
  const started = Date.now();
  let stdout = "unprobed";
  while (Date.now() - started < timeoutMs) {
    stdout = taggedPids(token);
    if (stdout.length === 0) return stdout;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return stdout;
}
