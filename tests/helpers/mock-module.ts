import { afterAll, mock } from "bun:test";
import { fileURLToPath } from "node:url";

// `mock.module` keys its registry by filesystem path, not by `file://` URL --
// registering under a URL string silently fails to intercept a module
// resolved elsewhere by relative specifier, once anything else in the
// process has already loaded the real module. `import.meta.resolve` returns
// a `file://` URL for relative specifiers, so normalize it back to a path.
function toModulePath(path: string): string {
  return path.startsWith("file://") ? fileURLToPath(path) : path;
}

async function captureModule<T extends object>(path: string): Promise<T> {
  // Bun mutates the imported namespace object in place when a module is
  // mocked, so the capture must be a shallow copy taken before any mock
  // installs -- holding onto the live namespace would silently turn into
  // the mocked exports as soon as mock.module runs.
  return { ...(await import(path)) } as T;
}

/**
 * Mocks a module for the rest of this test file and registers its own
 * `afterAll` restore, so correctness never depends on remembering to add
 * one. Bun runs every test file in a single process, so an un-restored
 * `mock.module` silently replaces the real module for every file that runs
 * after this one -- this is the only sanctioned way to call `mock.module`
 * at file scope.
 *
 * `impl` receives the captured real module so mocks can spread it
 * (`...real`) without a separate capture line.
 *
 * Pass `path` as `import.meta.resolve("./relative/path.js")` from the
 * calling file, not a bare relative specifier -- both `import()` and
 * `mock.module` inside this helper resolve relative specifiers against
 * this file's own location, not the caller's.
 */
export async function withMockedModule<T extends object>(
  path: string,
  impl: (real: T) => object,
): Promise<T> {
  const modulePath = toModulePath(path);
  const real = await captureModule<T>(modulePath);
  mock.module(modulePath, () => impl(real));
  afterAll(() => {
    mock.module(modulePath, () => real);
  });
  return real;
}

/**
 * Mocks a module only for the duration of `run`, restoring it immediately
 * afterward -- even if `run` throws -- rather than leaving it mocked for
 * the rest of the file. Use this when a mock only needs to apply around a
 * single call.
 *
 * Pass `path` as `import.meta.resolve("./relative/path.js")` -- see
 * `withMockedModule` above.
 */
export async function withMockedModuleDuring<T extends object, R>(
  path: string,
  impl: (real: T) => object,
  run: () => Promise<R>,
): Promise<R> {
  const modulePath = toModulePath(path);
  const real = await captureModule<T>(modulePath);
  mock.module(modulePath, () => impl(real));
  try {
    return await run();
  } finally {
    mock.module(modulePath, () => real);
  }
}
