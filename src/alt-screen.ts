export function enterAltScreen(): () => void {
  const exitAltScreen = (): void => {
    process.stdout.write("\x1b[?1049l");
  };
  process.stdout.write("\x1b[?1049h");
  process.once("exit", exitAltScreen);
  return (): void => {
    process.removeListener("exit", exitAltScreen);
    exitAltScreen();
  };
}
