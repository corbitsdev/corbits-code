/** Shakespeare worker — docs maintenance (PRODUCT / ARCHITECTURE / IMPLEMENTATION). */
export const config = {
  spawn: { maySpawn: false },
  tier: "leaf",
  modelRole: "docs",
} as const satisfies {
  spawn: { maySpawn: boolean };
  tier: string;
  modelRole: string;
};
