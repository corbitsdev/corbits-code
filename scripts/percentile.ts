// Shared percentile for the forensics scripts. `sorted` must be sorted in
// ascending order; an empty array yields 0.
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  const value = sorted[index];
  if (value === undefined) return 0;
  return value;
}
