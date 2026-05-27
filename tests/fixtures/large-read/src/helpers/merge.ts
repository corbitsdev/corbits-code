export function mergeObjects<T, U>(a: T, b: U): T & U {
  return { ...a, ...b } as T & U;
}
