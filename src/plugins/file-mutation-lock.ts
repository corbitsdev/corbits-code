// Serializes write_file / edit_file per path so verify-plugin's before/after
// snapshot stays consistent when the model issues parallel edits on one file.

const tails = new Map<string, Promise<unknown>>();

export async function withFileMutationLock<T>(filePath: string, run: () => Promise<T>): Promise<T> {
  const prev = tails.get(filePath) ?? Promise.resolve();
  const op = prev.catch(() => undefined).then(run);
  tails.set(filePath, op);
  try {
    return await op;
  } finally {
    if (tails.get(filePath) === op) {
      tails.delete(filePath);
    }
  }
}
