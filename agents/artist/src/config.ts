/** Artist worker — visual asset specialist. */
export const config = {
  spawn: { maySpawn: false },
  tier: "leaf",
  // Preserved from the original in-tree card (behavior wins over the contract
  // §5 map; both implement and docs default to medium effort in identity.ts).
  modelRole: "implement",
} as const satisfies {
  spawn: { maySpawn: boolean };
  tier: string;
  modelRole: string;
};
