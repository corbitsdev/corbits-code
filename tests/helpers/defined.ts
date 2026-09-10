export function defined<T>(value: T | null | undefined, label = "value"): T {
  if (value == null) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}
