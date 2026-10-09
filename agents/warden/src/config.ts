// Warden is a leaf trust-review worker: maySpawn false, no allowlist.
export const config = {
  spawn: {
    maySpawn: false,
  },
  tier: "leaf",
  modelRole: "review",
} as const satisfies {
  spawn: { maySpawn: boolean; allowlist?: readonly string[] };
  tier: string;
  modelRole: string;
};
