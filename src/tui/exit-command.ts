// Typing "exit" or "quit" alone in the prompt quits Corbits Code, matching the
// muscle memory of shells and REPLs. Only the bare word counts — any other
// content means the operator is talking about exiting, not asking for it.
const EXIT_WORDS = new Set(["exit", "quit"]);

export function isExitCommand(message: string): boolean {
  return EXIT_WORDS.has(message.trim().toLowerCase());
}
