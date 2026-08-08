import { describe, expect, test } from "bun:test";
import { detectToolFingerprintThrash, TOOL_FINGERPRINT_HISTORY_CAP } from "./stop-policy.js";

describe("detectToolFingerprintThrash", () => {
  test("does not flag 4 identical fingerprints — legitimate polling", () => {
    const history = ["read_file:{\"path\":\"a.ts\"}", "read_file:{\"path\":\"a.ts\"}", "read_file:{\"path\":\"a.ts\"}", "read_file:{\"path\":\"a.ts\"}"];
    expect(detectToolFingerprintThrash(history).repeating).toBe(false);
  });

  test("flags 5 identical fingerprints", () => {
    const history = Array.from({ length: 5 }, () => "read_file:{\"path\":\"a.ts\"}");
    const result = detectToolFingerprintThrash(history);
    expect(result).toEqual({ repeating: true, period: 1, repeats: 5 });
  });

  test("flags an alternating A,B cycle after 3 full cycles", () => {
    const history: string[] = [];
    for (let i = 0; i < 3; i++) {
      history.push("read_file:{\"path\":\"a.ts\"}", "read_file:{\"path\":\"b.ts\"}");
    }
    const result = detectToolFingerprintThrash(history);
    expect(result).toEqual({ repeating: true, period: 2, repeats: 3 });
  });

  test("an alternating cycle over 200 turns still resolves to a repeating period", () => {
    const history: string[] = [];
    for (let i = 0; i < 100; i++) {
      history.push("read_file:{\"path\":\"a.ts\"}", "read_file:{\"path\":\"b.ts\"}");
    }
    // The director caps its rolling buffer; simulate the same cap here.
    const capped = history.slice(-TOOL_FINGERPRINT_HISTORY_CAP);
    expect(detectToolFingerprintThrash(capped).repeating).toBe(true);
  });

  test("flags a 3-call rotating cycle", () => {
    const history: string[] = [];
    for (let i = 0; i < 3; i++) {
      history.push(
        "read_file:{\"path\":\"a.ts\"}",
        "read_file:{\"path\":\"b.ts\"}",
        "read_file:{\"path\":\"c.ts\"}",
      );
    }
    const result = detectToolFingerprintThrash(history);
    expect(result).toEqual({ repeating: true, period: 3, repeats: 3 });
  });

  test("varied, non-repeating history never flags", () => {
    const history = Array.from({ length: 40 }, (_, i) => `read_file:{"path":"file-${i}.ts"}`);
    expect(detectToolFingerprintThrash(history).repeating).toBe(false);
  });
});
