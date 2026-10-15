// Runtime contracts and the inference event wire protocol. Process-specific
// consumers can import runtime-core without constructing the event union.
export * from "./runtime-core";
export * from "./inference-events";
// Compat re-export. Locally patched — see vendor/intx-types/PATCHES.md#vendor-types-ts-runtime-format-safety-rating-compat
// Upstream 4cc6972 moved `formatSafetyRatingText` to `format-safety-rating`,
// but the published `@corbits/openai-responses@0.2.1` dist imports it from
// the `./runtime` subpath; npm has no newer release importing the new
// subpath. Remove when a republished @corbits/openai-responses compiles
// against `@intx/types/format-safety-rating`.
export { formatSafetyRatingText } from "./format-safety-rating";
