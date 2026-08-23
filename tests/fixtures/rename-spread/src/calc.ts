import { addNumbers } from "./math.ts";

export function total(values: number[]): number {
  let sum = 0;
  for (const v of values) {
    sum = addNumbers(sum, v);
  }
  return sum;
}

export function average(values: number[]): number {
  if (values.length === 0) return 0;
  return total(values) / values.length;
}
