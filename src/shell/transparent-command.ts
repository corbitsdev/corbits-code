export interface TransparentCommand {
  executableIndex: number;
  assignmentValues: string[];
  wrapperIndexes: number[];
  terminal: boolean;
}

export interface TransparentCommandOptions {
  acceptsWrapper?: (token: string, program: string) => boolean;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/s;

const ENV_VALUE_FLAGS = new Set([
  "-u",
  "--unset",
  "-C",
  "--chdir",
  "--argv0",
  "-f",
  "--file",
  "-P",
]);
const ENV_BOOLEAN_SHORT_OPTIONS = new Set(["0", "i", "v"]);
const ENV_VALUE_SHORT_OPTIONS = new Set(["C", "P", "S", "a", "f", "u"]);

function isEnvValueEqualsFlag(token: string): boolean {
  return (
    token.startsWith("--unset=") ||
    token.startsWith("--chdir=") ||
    token.startsWith("--argv0=") ||
    token.startsWith("--file=")
  );
}

function advancePastValueFlag(
  tokens: readonly string[],
  index: number,
  flags: ReadonlySet<string>,
): number | undefined {
  const token = tokens[index];
  if (token === undefined || !flags.has(token)) return undefined;
  return Math.min(index + 2, tokens.length);
}

function advancePastShortOption(
  tokens: readonly string[],
  index: number,
  booleanOptions: ReadonlySet<string>,
  valueOptions: ReadonlySet<string>,
): number | undefined {
  const token = tokens[index];
  if (
    token === undefined ||
    !token.startsWith("-") ||
    token.startsWith("--") ||
    token === "-"
  ) {
    return undefined;
  }

  const options = token.slice(1);
  for (let optionIndex = 0; optionIndex < options.length; optionIndex++) {
    const option = options[optionIndex] ?? "";
    if (booleanOptions.has(option)) continue;
    if (!valueOptions.has(option)) return undefined;
    return optionIndex + 1 < options.length
      ? index + 1
      : Math.min(index + 2, tokens.length);
  }
  return index + 1;
}

function envSplitPayloadIndex(
  tokens: readonly string[],
  index: number,
): number | undefined {
  const token = tokens[index];
  if (token === "-S" || token === "--split-string") return index + 1;
  if (
    token === undefined ||
    !token.startsWith("-") ||
    token.startsWith("--") ||
    token === "-"
  ) {
    return undefined;
  }

  const splitIndex = token.indexOf("S", 1);
  if (splitIndex < 1) return undefined;
  const beforeSplit = token.slice(1, splitIndex);
  const afterSplit = token.slice(splitIndex + 1);
  const isBooleanCluster = (options: string): boolean =>
    [...options].every((option) => ENV_BOOLEAN_SHORT_OPTIONS.has(option));
  return isBooleanCluster(beforeSplit) && isBooleanCluster(afterSplit)
    ? index + 1
    : undefined;
}

export function skipEnvArguments(
  tokens: readonly string[],
  start: number,
  assignmentValues: string[],
): { executableIndex: number; terminal: boolean } {
  let index = start;
  let optionsEnded = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      index++;
      continue;
    }
    const assignment = ENV_ASSIGNMENT.exec(token);
    if (assignment !== null) {
      assignmentValues.push(assignment[1] ?? "");
      optionsEnded = true;
      index++;
      continue;
    }
    if (optionsEnded) break;
    const splitPayloadIndex = envSplitPayloadIndex(tokens, index);
    if (splitPayloadIndex !== undefined) {
      return { executableIndex: splitPayloadIndex, terminal: false };
    }
    const afterValue = advancePastValueFlag(tokens, index, ENV_VALUE_FLAGS);
    if (afterValue !== undefined) {
      index = afterValue;
      continue;
    }
    const afterShortOption = advancePastShortOption(
      tokens,
      index,
      ENV_BOOLEAN_SHORT_OPTIONS,
      ENV_VALUE_SHORT_OPTIONS,
    );
    if (afterShortOption !== undefined) {
      index = afterShortOption;
      continue;
    }
    if (TERMINAL_LONG_OPTIONS.has(token)) {
      return { executableIndex: start - 1, terminal: true };
    }
    if (
      isEnvValueEqualsFlag(token) ||
      (token.startsWith("-") && token !== "-")
    ) {
      index++;
      continue;
    }
    break;
  }
  return { executableIndex: index, terminal: false };
}

const NICE_VALUE_FLAGS = new Set(["-n", "--adjustment"]);
const TIMEOUT_VALUE_FLAGS = new Set(["-k", "--kill-after", "-s", "--signal"]);
const TIME_VALUE_FLAGS = new Set(["-o", "--output", "-f", "--format"]);
const NICE_BOOLEAN_SHORT_OPTIONS = new Set<string>();
const NICE_VALUE_SHORT_OPTIONS = new Set(["n"]);
const TIMEOUT_BOOLEAN_SHORT_OPTIONS = new Set(["f", "v"]);
const TIMEOUT_VALUE_SHORT_OPTIONS = new Set(["k", "s"]);
const TIME_BOOLEAN_SHORT_OPTIONS = new Set(["a", "p", "q", "v"]);
const TIME_VALUE_SHORT_OPTIONS = new Set(["f", "o"]);
const TERMINAL_LONG_OPTIONS = new Set(["--help", "--version"]);
const TIMEOUT_DURATION =
  /^\+?(?:(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|0[xX](?:[\da-fA-F]+(?:\.[\da-fA-F]*)?|\.[\da-fA-F]+)[pP][+-]?\d+)(?:[smhd])?|[iI][nN][fF](?:[iI][nN][iI][tT][yY])?)$/;

interface ParsedWrapperArguments {
  executableIndex: number;
  terminal: boolean;
}

function commandArguments(
  tokens: readonly string[],
  start: number,
): ParsedWrapperArguments {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;
    if (token === "--") return { executableIndex: index + 1, terminal: false };
    if (!token.startsWith("-") || token === "-") break;
    if (TERMINAL_LONG_OPTIONS.has(token) || /^-[^-]*[vV]/.test(token)) {
      return { executableIndex: start - 1, terminal: true };
    }
    index++;
  }
  return { executableIndex: index, terminal: false };
}

function skipWrapperOptions(
  tokens: readonly string[],
  start: number,
  valueFlags: ReadonlySet<string>,
  booleanShortOptions: ReadonlySet<string>,
  valueShortOptions: ReadonlySet<string>,
): ParsedWrapperArguments {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;
    if (token === "--") {
      return { executableIndex: index + 1, terminal: false };
    }
    const afterValue = advancePastValueFlag(tokens, index, valueFlags);
    if (afterValue !== undefined) {
      index = afterValue;
      continue;
    }
    const afterShortOption = advancePastShortOption(
      tokens,
      index,
      booleanShortOptions,
      valueShortOptions,
    );
    if (afterShortOption !== undefined) {
      index = afterShortOption;
      continue;
    }
    if (token.startsWith("--") && token.includes("=")) {
      index++;
      continue;
    }
    if (TERMINAL_LONG_OPTIONS.has(token)) {
      return { executableIndex: start - 1, terminal: true };
    }
    if (token.startsWith("-") && token !== "-") {
      index++;
      continue;
    }
    break;
  }
  return { executableIndex: index, terminal: false };
}

function skipTimeoutArguments(
  tokens: readonly string[],
  start: number,
): ParsedWrapperArguments {
  let index = start;
  let optionsEnded = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;
    if (TIMEOUT_DURATION.test(token)) {
      return { executableIndex: index + 1, terminal: false };
    }
    if (optionsEnded) break;
    if (token === "--") {
      optionsEnded = true;
      index++;
      continue;
    }
    const afterValue = advancePastValueFlag(tokens, index, TIMEOUT_VALUE_FLAGS);
    if (afterValue !== undefined) {
      index = afterValue;
      continue;
    }
    const afterShortOption = advancePastShortOption(
      tokens,
      index,
      TIMEOUT_BOOLEAN_SHORT_OPTIONS,
      TIMEOUT_VALUE_SHORT_OPTIONS,
    );
    if (afterShortOption !== undefined) {
      index = afterShortOption;
      continue;
    }
    if (token.startsWith("--") && token.includes("=")) {
      index++;
      continue;
    }
    if (TERMINAL_LONG_OPTIONS.has(token)) {
      return { executableIndex: start - 1, terminal: true };
    }
    if (token.startsWith("-") && token !== "-") {
      index++;
      continue;
    }
    break;
  }
  return { executableIndex: index, terminal: false };
}

export function programBasename(token: string): string {
  const bare = token.replace(/["']/g, "");
  const slash = Math.max(bare.lastIndexOf("/"), bare.lastIndexOf("\\"));
  return slash >= 0 ? bare.slice(slash + 1) : bare;
}

export function peelTransparentCommand(
  tokens: readonly string[],
  options: TransparentCommandOptions = {},
): TransparentCommand {
  const assignmentValues: string[] = [];
  const wrapperIndexes: number[] = [];
  let index = 0;

  while (index < tokens.length) {
    const assignment = ENV_ASSIGNMENT.exec(tokens[index] ?? "");
    if (assignment === null) break;
    assignmentValues.push(assignment[1] ?? "");
    index++;
  }

  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    const program = programBasename(token);
    if (options.acceptsWrapper?.(token, program) === false) break;
    if (program === "env") {
      const parsed = skipEnvArguments(tokens, index + 1, assignmentValues);
      if (parsed.terminal) {
        return {
          executableIndex: index,
          assignmentValues,
          wrapperIndexes,
          terminal: true,
        };
      }
      wrapperIndexes.push(index);
      index = parsed.executableIndex;
      continue;
    }
    if (program === "command") {
      const parsed = commandArguments(tokens, index + 1);
      if (parsed.terminal) {
        return {
          executableIndex: index,
          assignmentValues,
          wrapperIndexes,
          terminal: true,
        };
      }
      wrapperIndexes.push(index);
      index = parsed.executableIndex;
      continue;
    }
    if (program === "nice") {
      const parsed = skipWrapperOptions(
        tokens,
        index + 1,
        NICE_VALUE_FLAGS,
        NICE_BOOLEAN_SHORT_OPTIONS,
        NICE_VALUE_SHORT_OPTIONS,
      );
      if (parsed.terminal) {
        return {
          executableIndex: index,
          assignmentValues,
          wrapperIndexes,
          terminal: true,
        };
      }
      wrapperIndexes.push(index);
      index = parsed.executableIndex;
      continue;
    }
    if (program === "timeout") {
      const parsed = skipTimeoutArguments(tokens, index + 1);
      if (parsed.terminal) {
        return {
          executableIndex: index,
          assignmentValues,
          wrapperIndexes,
          terminal: true,
        };
      }
      wrapperIndexes.push(index);
      index = parsed.executableIndex;
      continue;
    }
    if (program === "time") {
      const parsed = skipWrapperOptions(
        tokens,
        index + 1,
        TIME_VALUE_FLAGS,
        TIME_BOOLEAN_SHORT_OPTIONS,
        TIME_VALUE_SHORT_OPTIONS,
      );
      if (parsed.terminal) {
        return {
          executableIndex: index,
          assignmentValues,
          wrapperIndexes,
          terminal: true,
        };
      }
      wrapperIndexes.push(index);
      index = parsed.executableIndex;
      continue;
    }
    if (["builtin", "nohup"].includes(program)) {
      wrapperIndexes.push(index);
      index++;
      continue;
    }
    break;
  }

  return {
    executableIndex: index,
    assignmentValues,
    wrapperIndexes,
    terminal: false,
  };
}
