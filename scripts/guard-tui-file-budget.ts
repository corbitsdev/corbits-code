import { type } from "arktype";

// Ratchet for the CL-6791 TUI split: every .ts file under src/tui gets a line
// budget in scripts/budgets.json, seeded at its size when the ratchet landed.
// Budgets only ever shrink — a file that exceeds its budget must be split, not
// re-seeded, and a new src/tui file must be added to budgets.json explicitly so
// adding it is a visible growth decision rather than silent accretion.

const Budgets = type("Record<string, number>");

const failures: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

async function main(): Promise<void> {
  const budgetsResult = Budgets(await Bun.file("scripts/budgets.json").json());
  if (budgetsResult instanceof type.errors) {
    process.stderr.write(
      `guard-tui-file-budget: scripts/budgets.json is malformed (expected a record of path -> line count):\n${budgetsResult.summary}\n`,
    );
    process.exit(1);
  }
  const budgets = budgetsResult;

  for await (const path of new Bun.Glob("src/tui/**/*.ts").scan(".")) {
    const text = await Bun.file(path).text();
    const lines = text.split("\n").length;

    const budget = budgets[path];
    if (budget === undefined) {
      fail(
        `${path}: not listed in scripts/budgets.json (${lines} lines) — add it with an explicit budget`,
      );
      continue;
    }
    if (lines > budget) {
      fail(
        `${path}: ${lines} lines exceeds budget of ${budget} — split the file instead of raising the budget`,
      );
    }
  }

  if (failures.length > 0) {
    process.stderr.write(
      `guard-tui-file-budget: ${failures.length} violation(s):\n` +
        failures.map((f) => `  ${f}`).join("\n") +
        "\n",
    );
    process.exit(1);
  }

  console.log(`guard-tui-file-budget: all src/tui files within budget`);
}

void main();
