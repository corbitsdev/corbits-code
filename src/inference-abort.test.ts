import { describe, expect, test } from "bun:test";
import {
  INFERENCE_ABORT_INTERNAL_RECOVERY,
  INFERENCE_ABORT_USER_STOP,
  isInternalRecoveryAbortRaw,
  isNonTerminalInferenceError,
} from "./inference-abort.js";

const HTML_503 =
  "<!DOCTYPE html><html><body>503 Service Unavailable</body></html>";

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

  test("distinguishes internal abort from user-stop", () => {
    expect(isNonTerminalInferenceError({ category: "timeout" })).toBe(true);
    expect(isNonTerminalInferenceError({ category: "retryable" })).toBe(true);
    expect(
      isNonTerminalInferenceError({
        category: "aborted",
        raw: { origin: INFERENCE_ABORT_INTERNAL_RECOVERY },
      }),
    ).toBe(true);
    expect(
      isNonTerminalInferenceError({
        category: "aborted",
        raw: { origin: INFERENCE_ABORT_USER_STOP },
      }),
    ).toBe(false);
    expect(isNonTerminalInferenceError({ category: "fatal" })).toBe(false);
  });
});

describe("isInternalRecoveryAbortRaw", () => {
  test("matches internal-recovery origin", () => {
    expect(
      isInternalRecoveryAbortRaw({ origin: INFERENCE_ABORT_INTERNAL_RECOVERY }),
    ).toBe(true);
    expect(
      isInternalRecoveryAbortRaw({ origin: INFERENCE_ABORT_USER_STOP }),
    ).toBe(false);
    expect(isInternalRecoveryAbortRaw(undefined)).toBe(false);
  });
});
