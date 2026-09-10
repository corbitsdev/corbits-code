import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { describe, expect, test } from "bun:test";

const FIXTURE = join(
  import.meta.dirname,
  "../fixtures/exec-shutdown-reap/simulate-reap.ts",
);

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return buffer;
}

async function waitUntilGone(token: string): Promise<string> {
  const started = Date.now();
  let stdout = "";
  while (Date.now() - started < 5_000) {
    const probe = spawnSync("pgrep", ["-f", token], { encoding: "utf8" });
    stdout = probe.stdout?.trim() ?? "";
    if (stdout.length === 0) return stdout;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return stdout;
}

describe.skipIf(process.platform === "win32")(
  "integration — exec shutdown reaps shell-guard children",
  () => {
    test.each([
      ["quit", "", 0],
      ["crash", "", 1],
      ["signal", "SIGINT", 130],
      ["signal", "SIGTERM", 143],
      ["signal", "SIGHUP", 129],
    ] as const)(
      "%s %s reaps the tagged child and disposes once",
      async (path, signal, expectedExitCode) => {
        const home = mkdtempSync(join(tmpdir(), "corbits-exec-reap-home-"));
        const token = `ic_reap_${randomUUID()}`;
        const countPath = join(home, "dispose-count");

        try {
          const proc = Bun.spawn(["bun", "run", FIXTURE], {
            cwd: home,
            env: {
              ...process.env,
              HOME: home,
              REAP_TOKEN: token,
              REAP_PATH: path,
              REAP_COUNT_PATH: countPath,
            },
            stdout: "pipe",
            stderr: "pipe",
          });

          const ready = await readLine(proc.stdout);
          if (!ready.includes("READY")) {
            const errText = await new Response(proc.stderr).text();
            throw new Error(
              `fixture did not report READY: ${JSON.stringify(ready)} stderr=${errText}`,
            );
          }

          if (
            signal === "SIGINT" ||
            signal === "SIGTERM" ||
            signal === "SIGHUP"
          ) {
            proc.kill(signal);
          }
          const exitCode = await proc.exited;
          expect(exitCode).toBe(expectedExitCode);

          const leftover = await waitUntilGone(token);
          expect(leftover).toBe("");
          expect(readFileSync(countPath, "utf8").trim()).toBe("1");
        } finally {
          spawnSync("pkill", ["-9", "-f", token]);
          rmSync(home, { recursive: true, force: true });
        }
      },
      15_000,
    );
  },
);
