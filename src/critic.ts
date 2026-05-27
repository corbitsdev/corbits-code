export type CritiqueResult = {
  passed: boolean;
  errors: string[];
};

const CRITIQUE_TIMEOUT_MS = 300_000;

async function runCommand(
  cwd: string,
  command: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timeout = new Promise<number>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // ignore
      }
      resolve(-1);
    }, CRITIQUE_TIMEOUT_MS);
  });

  const exitCode = await Promise.race([proc.exited, timeout]);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { exitCode, stdout, stderr, timedOut };
}

async function hasScript(cwd: string, name: string): Promise<boolean> {
  try {
    const file = Bun.file(`${cwd}/package.json`);
    const text = await file.text();
    const pkg = JSON.parse(text) as { scripts?: Record<string, string> };
    return pkg.scripts !== undefined && name in pkg.scripts;
  } catch {
    return false;
  }
}

async function hasTestFiles(cwd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      ["find", cwd, "-type", "f", "(", "-name", "*.test.*", "-o", "-name", "*.spec.*", "-o", "-name", "*_test_*", "-o", "-name", "*_spec_*", ")"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function runCritique(cwd: string): Promise<CritiqueResult> {
  const errors: string[] = [];

  if (await hasScript(cwd, "build")) {
    const buildResult = await runCommand(cwd, ["bun", "run", "build"]);
    if (buildResult.exitCode !== 0) {
      const detail = buildResult.timedOut ? " (timed out)" : "";
      errors.push(`Build failed${detail}: ${buildResult.stderr || buildResult.stdout}`);
    }
  }

  if (await hasScript(cwd, "typecheck")) {
    const typeResult = await runCommand(cwd, ["bun", "run", "typecheck"]);
    if (typeResult.exitCode !== 0) {
      const detail = typeResult.timedOut ? " (timed out)" : "";
      errors.push(`Type check failed${detail}: ${typeResult.stderr || typeResult.stdout}`);
    }
  }

  if (await hasTestFiles(cwd)) {
    const testResult = await runCommand(cwd, ["bun", "test"]);
    if (testResult.exitCode !== 0) {
      const detail = testResult.timedOut ? " (timed out)" : "";
      errors.push(`Tests failed${detail}: ${testResult.stderr || testResult.stdout}`);
    }
  }

  return { passed: errors.length === 0, errors };
}
