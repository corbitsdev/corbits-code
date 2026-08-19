import { test, expect } from "bun:test";
import {
  INFERENCE_ABORT_INTERNAL_RECOVERY,
  INFERENCE_ABORT_USER_STOP,
  isInternalRecoveryAbortRaw,
  isNonTerminalInferenceError,
} from "../../src/adapters/inference-abort.js";

test("isInternalRecoveryAbortRaw matches internal-recovery origin", () => {
  expect(isInternalRecoveryAbortRaw({ origin: INFERENCE_ABORT_INTERNAL_RECOVERY })).toBe(true);
  expect(isInternalRecoveryAbortRaw({ origin: INFERENCE_ABORT_USER_STOP })).toBe(false);
  expect(isInternalRecoveryAbortRaw(undefined)).toBe(false);
});

test("isNonTerminalInferenceError distinguishes internal abort from user-stop", () => {
  expect(isNonTerminalInferenceError({ category: "timeout" })).toBe(true);
  expect(isNonTerminalInferenceError({ category: "retryable" })).toBe(true);
  expect(isNonTerminalInferenceError({
    category: "aborted",
    raw: { origin: INFERENCE_ABORT_INTERNAL_RECOVERY },
  })).toBe(true);
  expect(isNonTerminalInferenceError({
    category: "aborted",
    raw: { origin: INFERENCE_ABORT_USER_STOP },
  })).toBe(false);
  expect(isNonTerminalInferenceError({ category: "fatal" })).toBe(false);
});