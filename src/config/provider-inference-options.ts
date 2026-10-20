import { type } from "arktype";

import { lazyCallable, memoSchema } from "../schema/lazy.js";

const contextWindow = memoSchema(() => type("number.integer > 0"));
const maxTokens = memoSchema(() => type("number.integer > 0"));
const temperature = memoSchema(() => type("0 <= number <= 2"));
const topP = memoSchema(() => type("0 <= number <= 1"));

export const ProviderInferenceOptionSchemas = {
  get contextWindow() {
    return contextWindow();
  },
  get maxTokens() {
    return maxTokens();
  },
  get temperature() {
    return temperature();
  },
  get topP() {
    return topP();
  },
};

function buildProviderInferenceOptionsSchema() {
  return type({
    "contextWindow?": contextWindow(),
    "maxTokens?": maxTokens(),
    "temperature?": temperature(),
    "topP?": topP(),
  }).narrow(
    (options, ctx) =>
      options.temperature === undefined ||
      options.topP === undefined ||
      ctx.mustBe("sampling options with only one of temperature and top p"),
  );
}

const providerInferenceOptionsSchema = memoSchema(
  buildProviderInferenceOptionsSchema,
);

export function readProviderInferenceOptionsSchema(): ReturnType<
  typeof buildProviderInferenceOptionsSchema
> {
  return providerInferenceOptionsSchema();
}

export const ProviderInferenceOptionsSchema: ReturnType<
  typeof buildProviderInferenceOptionsSchema
> = lazyCallable(providerInferenceOptionsSchema);
