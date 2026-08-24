import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createInterventionLog,
  INTERVENTION_FILE,
  NOOP_INTERVENTION_SINK,
  type InterventionRecord,
} from "./intervention-log.js";

async function readRecords(dir: string): Promise<InterventionRecord[]> {
  const raw = await readFile(join(dir, INTERVENTION_FILE), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as InterventionRecord);
}

async function flush(): Promise<void> {
  // Appends are fire-and-forget; yield until the chained writes settle.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("intervention log", () => {
  test("records carry the shared context, the measurement, and the run state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intervention-log-"));
    const sink = createInterventionLog(
      dir,
      {
        role: "leaf",
        provider: "xai",
        model: "grok-4.6",
        family: "grok",
        intent: "implement",
      },
      () => new Date("2026-08-23T12:00:00.000Z"),
    );

    sink({
      id: "stalled",
      class: "stop",
      measurement: { metric: "idleMs", value: 120000, threshold: 120000 },
      state: { turnsCompleted: 7, editedPaths: 2 },
      detail: "no output for 120s",
    });
    await flush();

    const [record] = await readRecords(dir);
    expect(record).toBeDefined();
    expect(record?.ts).toBe("2026-08-23T12:00:00.000Z");
    expect(record?.id).toBe("stalled");
    expect(record?.class).toBe("stop");
    expect(record?.family).toBe("grok");
    expect(record?.intent).toBe("implement");
    expect(record?.measurement).toEqual({
      metric: "idleMs",
      value: 120000,
      threshold: 120000,
    });
    // The false-positive proxy the forensics script reads: a stop that fired on
    // a run which had already edited files.
    expect(record?.state?.editedPaths).toBe(2);
  });

  test("appends in order, one JSON object per line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intervention-log-"));
    const sink = createInterventionLog(dir, { role: "leaf" });
    sink({ id: "report-forced", class: "nudge" });
    sink({ id: "turn-budget", class: "stop" });
    await flush();

    const records = await readRecords(dir);
    expect(records.map((r) => r.id)).toEqual(["report-forced", "turn-budget"]);
  });

  test("a write failure never throws into the caller", async () => {
    const sink = createInterventionLog(join(tmpdir(), "intervention-log-missing-dir-xyz"), {
      role: "leaf",
    });
    expect(() => {
      sink({ id: "stalled", class: "stop" });
    }).not.toThrow();
    await flush();
  });

  test("the no-op sink accepts events and writes nothing", () => {
    expect(() => {
      NOOP_INTERVENTION_SINK({ id: "no-progress", class: "stop" });
    }).not.toThrow();
  });
});
