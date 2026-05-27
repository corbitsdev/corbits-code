export type CritiqueResult = {
  passed: boolean;
  errors: string[];
};

async function runCommand(
  cwd: string,
  command: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { exitCode, stdout, stderr };
}

export async function runCritique(cwd: string): Promise<CritiqueResult> {
  const errors: string[] = [];

  const typeResult = await runCommand(cwd, ["bun", "run", "typecheck"]);
  if (typeResult.exitCode !== 0) {
    errors.push("Type check failed");
  }

  const testResult = await runCommand(cwd, ["bun", "test"]);
  if (testResult.exitCode !== 0) {
    errors.push("Tests failed");
  }

  return { passed: errors.length === 0, errors };
}
