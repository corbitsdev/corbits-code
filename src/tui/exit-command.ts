// Bare "exit"/"quit" quits, matching shell/REPL muscle memory; any other
// content is prose about exiting, not a request.
const EXIT_WORDS = new Set(["exit", "quit"]);

export function isExitCommand(message: string): boolean {
  return EXIT_WORDS.has(message.trim().toLowerCase());
}
