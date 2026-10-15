import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { waitUntilGone } from "../testkit/process-tag.js";
import { spawnSignalFixture } from "./signal-helpers.js";

const FIXTURE = join(
  import.meta.dirname,
  "../fixtures/exec-shutdown-reap/simulate-reap.ts",
);

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
        const token = `ic_reap_${randomUUID()}`;
        let countPath: string | undefined;
        const { proc, output, cleanup } = await spawnSignalFixture({
          fixture: FIXTURE,
          cwdPrefix: "corbits-exec-reap-cwd-",
          homePrefix: "corbits-exec-reap-home-",
          extraEnv: ({ home }) => {
            countPath = join(home, "dispose-count");
            return {
              REAP_TOKEN: token,
              REAP_PATH: path,
              REAP_COUNT_PATH: countPath,
            };
          },
        });

        const resolvedCountPath = countPath;
        if (resolvedCountPath === undefined)
          throw new Error("fixture env not resolved");

        try {
          expect(output).toContain("READY");
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
          expect(readFileSync(resolvedCountPath, "utf8").trim()).toBe("1");
        } finally {
          spawnSync("pkill", ["-9", "-f", token]);
          cleanup();
        }
      },
      15_000,
    );
  },
);
