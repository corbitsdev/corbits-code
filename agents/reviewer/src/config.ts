export const config = {
  spawn: { maySpawn: false },
  tier: "leaf",
  modelRole: "review",
} as const satisfies {
  spawn: { maySpawn: boolean };
  tier: string;
  modelRole: string;
};
