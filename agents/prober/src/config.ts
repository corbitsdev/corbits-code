/** Prober worker — measure-only latency/behavior prober per family/model. */
export const config = {
  spawn: { maySpawn: false },
  tier: "leaf",
  // Preserved from the original in-tree card (behavior wins over the contract
  // §5 map; test defaults to medium effort in identity.ts, matching the
  // measure-only lane).
  modelRole: "test",
} as const satisfies {
  spawn: { maySpawn: boolean };
  tier: string;
  modelRole: string;
};
