import { addNumbers, double } from "./math.ts";
import { average, total } from "./calc.ts";

export function report(values: number[]): { sum: number; mean: number; twiceFirst: number } {
  const first = values[0] ?? 0;
  return {
    sum: total(values),
    mean: average(values),
    twiceFirst: double(first),
  };
}

export function pairSum(a: number, b: number): number {
  return addNumbers(a, b);
}
