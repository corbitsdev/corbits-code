export const config = {
  spawn: { maySpawn: false },
  tier: "leaf",
  modelRole: "implement",
} as const satisfies {
  spawn: { maySpawn: boolean };
  tier: string;
  modelRole: string;
};
