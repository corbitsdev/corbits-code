export function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}
