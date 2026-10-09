export const config = {
  spawn: { maySpawn: false },
  tier: "leaf",
  modelRole: "explore",
} as const satisfies {
  spawn: { maySpawn: boolean; allowlist?: readonly string[] };
  tier: string;
  modelRole: string;
};
