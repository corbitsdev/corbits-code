export type ShellDialect = "posix" | "cmd";

export function nativeShellDialect(platform: NodeJS.Platform): ShellDialect {
  return platform === "win32" ? "cmd" : "posix";
}

function isPosixControlBoundary(char: string | undefined): boolean {
  return char === undefined || /[\s;&|()]/.test(char);
}

function isStandalonePosixReservedWord(
  command: string,
  index: number,
): boolean {
  return (
    isPosixControlBoundary(command[index - 1]) &&
    isPosixControlBoundary(command[index + 1])
  );
}

interface LiteralPathCommandInspection {
  commands: string[][];
  opaque: boolean;
}

interface ANSIQuotedLiteral {
  value: string;
  end: number;
  opaque: boolean;
}

const ANSI_SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\",
  "'": "'",
  '"': '"',
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

function decodeANSIQuotedLiteral(
  command: string,
  start: number,
): ANSIQuotedLiteral {
  let value = "";
  let opaque = false;
  for (let index = start + 2; index < command.length; index++) {
    const char = command[index] ?? "";
    if (char === "'") return { value, end: index, opaque };
    if (char !== "\\") {
      value += char;
      continue;
    }

    const escape = command[index + 1];
    if (escape === undefined) return { value, end: index, opaque: true };
    const simple = ANSI_SIMPLE_ESCAPES[escape];
    if (simple !== undefined) {
      value += simple;
      index++;
      continue;
    }
    if (/[0-7]/.test(escape)) {
      const digits = command.slice(index + 1).match(/^[0-7]{1,3}/)?.[0] ?? "";
      value += String.fromCodePoint(Number.parseInt(digits, 8));
      index += digits.length;
      continue;
    }
    if (escape === "x") {
      const digits = command.slice(index + 2).match(/^[0-9A-Fa-f]{1,2}/)?.[0];
      if (digits === undefined) {
        opaque = true;
        index++;
        continue;
      }
      value += String.fromCodePoint(Number.parseInt(digits, 16));
      index += digits.length + 1;
      continue;
    }
    if (escape === "u" || escape === "U") {
      const length = escape === "u" ? 4 : 8;
      const digits = command.slice(index + 2, index + 2 + length);
      const codePoint = Number.parseInt(digits, 16);
      if (
        digits.length !== length ||
        !/^[0-9A-Fa-f]+$/.test(digits) ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        opaque = true;
        index++;
        continue;
      }
      value += String.fromCodePoint(codePoint);
      index += length + 1;
      continue;
    }
    opaque = true;
    index++;
  }
  return { value, end: command.length - 1, opaque: true };
}

function inspectPosixLiteralPathArgumentCommands(
  command: string,
): LiteralPathCommandInspection {
  const commands: string[][] = [];
  let opaque = false;
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote: "single" | "double" | undefined;
  let inBacktick = false;
  let backtickRestoreQuote: "double" | undefined;
  let inDollarSubstitution = false;
  let dollarRestoreQuote: "double" | undefined;

  const flush = (): void => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const flushCommand = (): void => {
    flush();
    if (words.length > 0) commands.push(words);
    words = [];
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index] ?? "";

    if (quote === "single") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }

    if (quote === "double") {
      if (char === '"') {
        quote = undefined;
        continue;
      }
      if (char === "\\") {
        const next = command[index + 1];
        if (
          next === "$" ||
          next === "`" ||
          next === '"' ||
          next === "\\" ||
          next === "\n"
        ) {
          if (next !== "\n") word += next;
          index++;
        } else {
          word += char;
        }
        continue;
      }
      if (char === "`") {
        if (word.length === 0) started = false;
        flushCommand();
        quote = undefined;
        inBacktick = true;
        backtickRestoreQuote = "double";
        continue;
      }
      if (char === "$" && command[index + 1] === "(") {
        if (word.length === 0) started = false;
        flushCommand();
        quote = undefined;
        inDollarSubstitution = true;
        dollarRestoreQuote = "double";
        index++;
        continue;
      }
      word += char;
      continue;
    }

    if (char === "`") {
      flushCommand();
      if (inBacktick) {
        quote = backtickRestoreQuote;
        inBacktick = false;
        backtickRestoreQuote = undefined;
      } else {
        inBacktick = true;
        backtickRestoreQuote = quote;
      }
      continue;
    }

    if (char === "$" && command[index + 1] === "(") {
      flushCommand();
      inDollarSubstitution = true;
      dollarRestoreQuote = undefined;
      index++;
      continue;
    }
    if (char === ")" && inDollarSubstitution) {
      flushCommand();
      quote = dollarRestoreQuote;
      inDollarSubstitution = false;
      dollarRestoreQuote = undefined;
      continue;
    }

    if (
      (char === "{" || char === "}") &&
      isStandalonePosixReservedWord(command, index)
    ) {
      flushCommand();
      continue;
    }
    if (
      char === "!" &&
      words.length === 0 &&
      !started &&
      isPosixControlBoundary(command[index + 1])
    ) {
      continue;
    }
    if (/[;&|()\n]/.test(char)) {
      flushCommand();
      continue;
    }
    if (/\s/.test(char) || /[<>]/.test(char)) {
      flush();
      continue;
    }
    if (char === "$" && command[index + 1] === "'") {
      const literal = decodeANSIQuotedLiteral(command, index);
      word += literal.value;
      started = true;
      opaque ||= literal.opaque;
      index = literal.end;
      continue;
    }
    if (char === "'") {
      quote = "single";
      started = true;
      continue;
    }
    if (char === '"') {
      quote = "double";
      started = true;
      continue;
    }
    if (char === "\\") {
      started = true;
      const next = command[index + 1];
      if (next !== undefined) {
        if (next !== "\n") word += next;
        index++;
      } else {
        word += char;
      }
      continue;
    }
    started = true;
    word += char;
  }

  flushCommand();
  return { commands, opaque };
}

function cmdLiteralPathArgumentCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quoted = false;

  const flushWord = (): void => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const flushCommand = (): void => {
    flushWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index] ?? "";

    if (char === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /[&|\r\n]/.test(char)) {
      flushCommand();
      continue;
    }
    if (!quoted && (/\s/.test(char) || /[<>()]/.test(char))) {
      flushWord();
      continue;
    }
    if (!quoted && char === "^") {
      started = true;
      const next = command[index + 1];
      if (next === "\n") {
        index++;
        continue;
      }
      if (next === "\r" && command[index + 2] === "\n") {
        index += 2;
        continue;
      }
      if (next !== undefined) {
        word += next;
        index++;
      } else {
        word += char;
      }
      continue;
    }
    started = true;
    word += char;
  }

  flushCommand();
  return commands;
}

export function inspectLiteralPathArgumentCommands(
  command: string,
  dialect: ShellDialect,
): LiteralPathCommandInspection {
  return dialect === "cmd"
    ? { commands: cmdLiteralPathArgumentCommands(command), opaque: false }
    : inspectPosixLiteralPathArgumentCommands(command);
}

export function literalPathArgumentCommands(
  command: string,
  dialect: ShellDialect,
): string[][] {
  return inspectLiteralPathArgumentCommands(command, dialect).commands;
}

export function literalPathArguments(
  command: string,
  dialect: ShellDialect,
): string[] {
  return literalPathArgumentCommands(command, dialect).flat();
}
