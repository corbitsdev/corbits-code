import { describe, expect, test } from "bun:test";
import {
  INFERENCE_ABORT_INTERNAL_RECOVERY,
  isNonTerminalInferenceError,
} from "./inference-abort.js";

const HTML_503 = "<!DOCTYPE html><html><body>503 Service Unavailable</body></html>";

describe("isNonTerminalInferenceError", () => {
  test("gateway HTML protocol_mismatch is non-terminal", () => {
    expect(
      isNonTerminalInferenceError({
        category: "protocol_mismatch",
        message: "malformed JSON",
        raw: HTML_503,
      }),
    ).toBe(true);
  });

  test("ordinary protocol_mismatch stays terminal", () => {
    expect(
      isNonTerminalInferenceError({
        category: "protocol_mismatch",
        message: "schema validation failed",
        raw: { bad: true },
      }),
    ).toBe(false);
  });

  test("internal recovery abort remains non-terminal", () => {
    expect(
      isNonTerminalInferenceError({
        category: "aborted",
        message: "inference aborted",
        raw: { origin: INFERENCE_ABORT_INTERNAL_RECOVERY },
      }),
    ).toBe(true);
  });
});
