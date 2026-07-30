import { mock } from "bun:test";
import { loadYoga } from "yoga-layout/load";

// Under `bun test --isolate`, each test file re-evaluates its module graph
// in a fresh global. yoga-layout's default entry point resolves its WASM
// binding through a cyclic import (index.js awaits its loader while also
// re-exporting from a module its own loader depends on) using a top-level
// await; that cyclic TLA races ink's static import of it in the fresh
// graph, leaving `Yoga` in its temporal dead zone (see
// https://github.com/oven-sh/bun/issues/30651). The "yoga-layout/load"
// entry point has no such top-level await — `loadYoga` is a plain async
// function — so mocking the default entry point onto it sidesteps the race.
// The mock factory must be registered without any preceding `await` in this
// file, or the registration itself is discarded by the isolate reset.
mock.module("yoga-layout", async () => {
  const Yoga = await loadYoga();
  return { default: Yoga, ...Yoga };
});
