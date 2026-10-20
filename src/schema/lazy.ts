let materializations = 0;

/** How many memoized schemas have been built in this process. */
export function schemaMaterializations(): number {
  return materializations;
}

export function memoSchema<T>(build: () => T): () => T {
  let cached: T | undefined;
  let ready = false;
  return () => {
    if (!ready) {
      cached = build();
      ready = true;
      materializations += 1;
    }
    return cached as T;
  };
}

/**
 * Callable stand-in that forwards to the memoized schema on first use.
 * Composition that needs a real arktype instance should call the getter
 * instead of passing this object into `type()`.
 */
export function lazyCallable<T extends object>(load: () => T): T {
  function lazySchema(this: unknown, ...args: unknown[]) {
    const schema = load() as (...args: unknown[]) => unknown;
    return Reflect.apply(schema, this, args);
  }
  return new Proxy(lazySchema as unknown as T, {
    apply(_target, thisArg, argArray) {
      const schema = load() as (...args: unknown[]) => unknown;
      return Reflect.apply(schema, thisArg, argArray);
    },
    get(_target, prop) {
      // Awaiting the stand-in must not materialize it.
      if (prop === "then") return undefined;
      const schema = load() as Record<PropertyKey, unknown>;
      const value = Reflect.get(schema, prop, schema);
      if (typeof value === "function") {
        return (value as (...args: unknown[]) => unknown).bind(schema);
      }
      return value;
    },
    has(_target, prop) {
      return prop in (load() as object);
    },
  });
}
