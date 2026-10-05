import { describe, expect, test } from "bun:test";
import {
  INTERCHANGE_LOOP_ENV_VAR,
  isInterchangeLoopEnabled,
  resolveInterchangeLoopRunner,
} from "./interchange-loop.js";

function envWith(value: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (value !== undefined) env[INTERCHANGE_LOOP_ENV_VAR] = value;
  return env;
}

describe("isInterchangeLoopEnabled", () => {
  test("is disabled by default", () => {
    expect(isInterchangeLoopEnabled(envWith(undefined))).toBe(false);
  });

  test.each(["1", "true", "TRUE", " True "])("is enabled for %j", (value) => {
    expect(isInterchangeLoopEnabled(envWith(value))).toBe(true);
  });

  test.each(["0", "false", "yes", ""])("stays disabled for %j", (value) => {
    expect(isInterchangeLoopEnabled(envWith(value))).toBe(false);
  });

  test("never reads process.env when an env is passed", () => {
    const prior = process.env.CORBITS_INTERCHANGE_LOOP;
    process.env.CORBITS_INTERCHANGE_LOOP = "1";
    try {
      expect(isInterchangeLoopEnabled(envWith(undefined))).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.CORBITS_INTERCHANGE_LOOP;
      else process.env.CORBITS_INTERCHANGE_LOOP = prior;
    }
  });
});

describe("resolveInterchangeLoopRunner", () => {
  test("never throws and reports unavailable without the workflow package", async () => {
    // `@intx/workflow` is not installed in this tree (it arrives with the
    // 0.4.0 hub), so the seam must fall back instead of rejecting.
    const status = await resolveInterchangeLoopRunner();
    expect(status.status).toBe("unavailable");
    if (status.status === "unavailable") {
      expect(status.reason).toContain("@intx/workflow");
    }
  });
});
