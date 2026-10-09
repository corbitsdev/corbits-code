// Dispatch config — uniform `{ spawn, tier, modelRole }` shape (§5).
// dispatch is the Tier-1 primary orchestrator: maySpawn true with spawn
// allowlist; others are leaf workers with no allowlist.
export const config = {
  spawn: {
    maySpawn: true,
    allowlist: [
      "explorer",
      "planner",
      "coder",
      "reviewer",
      "designer",
      "artist",
      "warden",
      "shakespeare",
      "prober",
      "qa-lead",
    ],
  },
  tier: "orchestrator",
  modelRole: "orchestrator",
} as const satisfies {
  spawn: { maySpawn: boolean; allowlist?: readonly string[] };
  tier: string;
  modelRole: string;
};
