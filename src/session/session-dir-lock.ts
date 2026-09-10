import path from "node:path";

const locks = new Map<string, Promise<unknown>>();

/**
 * Process-wide mutex keyed by resolved directory. Wrapper staging and
 * `base.commit()` / audit writes must not interleave on the same repo.
 */
export async function withResolvedDirLock<T>(
  dir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(dir);
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(
    () => current,
    () => current,
  );
  locks.set(key, tail);
  try {
    await previous.then(
      () => undefined,
      () => undefined,
    );
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}
