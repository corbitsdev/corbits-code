export interface ShortOptionGrammar {
  booleanOptions: ReadonlySet<string>;
  valueOptions: ReadonlySet<string>;
  fileOption: string;
  minimumLongFileOptionPrefixLength?: number;
  numericBooleanOptions?: boolean;
}

const GREP_OPTION_GRAMMAR: ShortOptionGrammar = {
  booleanOptions: new Set([
    "E",
    "F",
    "G",
    "H",
    "I",
    "J",
    "L",
    "O",
    "P",
    "R",
    "S",
    "T",
    "U",
    "Z",
    "a",
    "b",
    "c",
    "h",
    "i",
    "l",
    "n",
    "o",
    "q",
    "r",
    "s",
    "v",
    "w",
    "x",
    "y",
    "z",
  ]),
  valueOptions: new Set(["A", "B", "C", "D", "d", "e", "f", "m"]),
  fileOption: "f",
  numericBooleanOptions: true,
};

export const FILE_OPTION_GRAMMARS: Readonly<
  Record<string, ShortOptionGrammar>
> = {
  grep: GREP_OPTION_GRAMMAR,
  egrep: GREP_OPTION_GRAMMAR,
  fgrep: GREP_OPTION_GRAMMAR,
  sed: {
    booleanOptions: new Set(["E", "a", "n", "r", "s", "u", "z"]),
    valueOptions: new Set(["e", "f", "i", "l"]),
    fileOption: "f",
    minimumLongFileOptionPrefixLength: 2,
  },
  awk: {
    booleanOptions: new Set(),
    valueOptions: new Set(["E", "F", "f", "i", "l", "v"]),
    fileOption: "f",
  },
};

export interface ShortValueOption {
  option: string;
  attachedValue: string | undefined;
}

export interface ShortOptionInspection {
  valueOption: ShortValueOption | undefined;
  ambiguousFileOption: boolean;
}

function isBooleanOption(option: string, grammar: ShortOptionGrammar): boolean {
  return (
    grammar.booleanOptions.has(option) ||
    (grammar.numericBooleanOptions === true && /^\d$/.test(option))
  );
}

export function inspectShortOptions(
  token: string,
  grammar: ShortOptionGrammar,
): ShortOptionInspection {
  if (!token.startsWith("-") || token.startsWith("--") || token === "-") {
    return { valueOption: undefined, ambiguousFileOption: false };
  }

  const options = token.slice(1);
  for (let index = 0; index < options.length; index++) {
    const option = options[index] ?? "";
    if (isBooleanOption(option, grammar)) continue;
    if (!grammar.valueOptions.has(option)) {
      return {
        valueOption: undefined,
        ambiguousFileOption: options
          .slice(index + 1)
          .includes(grammar.fileOption),
      };
    }
    return {
      valueOption: {
        option,
        attachedValue: options.slice(index + 1) || undefined,
      },
      ambiguousFileOption: false,
    };
  }
  return { valueOption: undefined, ambiguousFileOption: false };
}

export function firstShortValueOption(
  token: string,
  grammar: ShortOptionGrammar,
): ShortValueOption | undefined {
  return inspectShortOptions(token, grammar).valueOption;
}

export function isLongFileOption(
  token: string,
  grammar: ShortOptionGrammar,
): boolean {
  if (!token.startsWith("--")) return false;
  const option = token.slice(2).split("=", 1)[0] ?? "";
  if (option === "file") return true;
  const minimumLength = grammar.minimumLongFileOptionPrefixLength;
  return (
    minimumLength !== undefined &&
    option.length >= minimumLength &&
    "file".startsWith(option)
  );
}
