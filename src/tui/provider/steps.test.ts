import { describe, expect, test } from "bun:test";

import {
  CUSTOM_STEPS,
  OAUTH_STEPS,
  OLLAMA_STEPS,
  PRESET_STEPS,
  nextSamplingStepIndex,
  previousSamplingStepIndex,
  skipTopPWhenTemperatureSet,
  topPAfterTemperatureAdvance,
} from "./steps.js";

const temperatureIndex = CUSTOM_STEPS.indexOf("temperature");
const topPIndex = CUSTOM_STEPS.indexOf("topP");
const effortsIndex = CUSTOM_STEPS.indexOf("efforts");
const maxTokensIndex = CUSTOM_STEPS.indexOf("maxTokens");
const defaultEffortIndex = CUSTOM_STEPS.indexOf("defaultEffort");

describe("custom provider sampling-step skip", () => {
  test("CUSTOM_STEPS includes sampling and effort steps", () => {
    expect(temperatureIndex).toBeGreaterThanOrEqual(0);
    expect(topPIndex).toBeGreaterThanOrEqual(0);
    expect(effortsIndex).toBeGreaterThanOrEqual(0);
    expect(maxTokensIndex).toBeGreaterThanOrEqual(0);
    expect(defaultEffortIndex).toBeGreaterThanOrEqual(0);
  });

  test("nextSamplingStepIndex skips topP when temperature is set", () => {
    expect(nextSamplingStepIndex(CUSTOM_STEPS, temperatureIndex, "0.7")).toBe(
      effortsIndex,
    );
    expect(nextSamplingStepIndex(CUSTOM_STEPS, temperatureIndex, "0")).toBe(
      effortsIndex,
    );
  });

  test("nextSamplingStepIndex does not skip topP when temperature is blank", () => {
    expect(nextSamplingStepIndex(CUSTOM_STEPS, temperatureIndex, "")).toBe(
      topPIndex,
    );
    expect(nextSamplingStepIndex(CUSTOM_STEPS, temperatureIndex, "  ")).toBe(
      topPIndex,
    );
  });

  test("nextSamplingStepIndex advances from topP to efforts", () => {
    expect(nextSamplingStepIndex(CUSTOM_STEPS, topPIndex, "")).toBe(
      effortsIndex,
    );
    expect(nextSamplingStepIndex(CUSTOM_STEPS, topPIndex, "0.7")).toBe(
      effortsIndex,
    );
  });

  test("nextSamplingStepIndex does not skip the temperature step", () => {
    expect(nextSamplingStepIndex(CUSTOM_STEPS, maxTokensIndex, "0.7")).toBe(
      temperatureIndex,
    );
  });

  test("nextSamplingStepIndex is +1 on lists without sampling steps", () => {
    expect(nextSamplingStepIndex(PRESET_STEPS, 0, "0.7")).toBe(1);
    expect(nextSamplingStepIndex(OAUTH_STEPS, 0, "0.7")).toBe(1);
    expect(nextSamplingStepIndex(OLLAMA_STEPS, 0, "0.7")).toBe(1);
  });

  test("previousSamplingStepIndex skips topP when temperature is set", () => {
    expect(previousSamplingStepIndex(CUSTOM_STEPS, effortsIndex, "0.7")).toBe(
      temperatureIndex,
    );
    expect(previousSamplingStepIndex(CUSTOM_STEPS, effortsIndex, "0")).toBe(
      temperatureIndex,
    );
  });

  test("previousSamplingStepIndex does not skip topP when temperature is blank", () => {
    expect(previousSamplingStepIndex(CUSTOM_STEPS, effortsIndex, "")).toBe(
      topPIndex,
    );
    expect(previousSamplingStepIndex(CUSTOM_STEPS, effortsIndex, "  ")).toBe(
      topPIndex,
    );
  });

  test("previousSamplingStepIndex from topP lands on temperature", () => {
    expect(previousSamplingStepIndex(CUSTOM_STEPS, topPIndex, "0.7")).toBe(
      temperatureIndex,
    );
    expect(previousSamplingStepIndex(CUSTOM_STEPS, topPIndex, "")).toBe(
      temperatureIndex,
    );
  });

  test("previousSamplingStepIndex does not skip two steps", () => {
    expect(
      previousSamplingStepIndex(CUSTOM_STEPS, defaultEffortIndex, "0.7"),
    ).toBe(effortsIndex);
  });

  test("previousSamplingStepIndex floors at 0", () => {
    expect(previousSamplingStepIndex(CUSTOM_STEPS, 0, "0.7")).toBe(0);
  });

  test("topPAfterTemperatureAdvance clears topP only when temperature is set", () => {
    expect(topPAfterTemperatureAdvance("0.7", "0.9")).toBe("");
    expect(topPAfterTemperatureAdvance("0", "0.9")).toBe("");
    expect(topPAfterTemperatureAdvance("", "0.9")).toBe("0.9");
    expect(topPAfterTemperatureAdvance("  ", "0.9")).toBe("0.9");
  });

  test("skipTopPWhenTemperatureSet treats 0 as set and whitespace as unset", () => {
    expect(skipTopPWhenTemperatureSet("0")).toBe(true);
    expect(skipTopPWhenTemperatureSet("0.7")).toBe(true);
    expect(skipTopPWhenTemperatureSet("")).toBe(false);
    expect(skipTopPWhenTemperatureSet("  ")).toBe(false);
  });
});
