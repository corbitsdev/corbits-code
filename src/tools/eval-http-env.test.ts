import { describe, expect, test } from "bun:test";
import { evalHttpEnvGet, runWithEvalHttpEnv } from "./eval-http-env.js";

describe("evalHttpEnv ALS", () => {
  test("overlapping async callbacks each see only their own URL", async () => {
    const urlA = "http://127.0.0.1:1111/";
    const urlB = "http://127.0.0.1:2222/";
    let aSaw: string | undefined;
    let bSaw: string | undefined;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const runA = runWithEvalHttpEnv({ EVAL_HTTP_URL: urlA }, async () => {
      await hold;
      aSaw = evalHttpEnvGet("EVAL_HTTP_URL");
    });
    const runB = runWithEvalHttpEnv({ EVAL_HTTP_URL: urlB }, async () => {
      await hold;
      bSaw = evalHttpEnvGet("EVAL_HTTP_URL");
    });

    release();
    await Promise.all([runA, runB]);
    expect(aSaw).toBe(urlA);
    expect(bSaw).toBe(urlB);
    expect(aSaw).not.toBe(bSaw);
  });

  test("falls back to process.env when no overlay is active", () => {
    const prior = process.env.EVAL_HTTP_URL;
    process.env.EVAL_HTTP_URL = "http://127.0.0.1:9/";
    try {
      expect(evalHttpEnvGet("EVAL_HTTP_URL")).toBe("http://127.0.0.1:9/");
    } finally {
      if (prior === undefined) delete process.env.EVAL_HTTP_URL;
      else process.env.EVAL_HTTP_URL = prior;
    }
  });
});
