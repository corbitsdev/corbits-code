export function cacheResult<T>(fn: () => T): T {
  return fn();
}
