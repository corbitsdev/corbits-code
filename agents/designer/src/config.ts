// Designer config — uniform `{ spawn, tier, modelRole }` shape (§5).
// designer is a leaf worker: maySpawn false, no allowlist.
// modelRole is "implement" (matches the in-tree card).
export const config = {
  spawn: {
    maySpawn: false,
  },
  tier: "leaf",
  modelRole: "implement",
} as const satisfies {
  spawn: { maySpawn: boolean; allowlist?: readonly string[] };
  tier: string;
  modelRole: string;
};
