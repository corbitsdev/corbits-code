import { useStdout } from "ink";
import { useEffect, useState } from "react";

export type TerminalSize = { columns: number; rows: number };

const FALLBACK_COLUMNS = 80;
const FALLBACK_ROWS = 24;

function readSize(stdout: NodeJS.WriteStream | undefined): TerminalSize {
  return {
    columns: stdout?.columns ?? FALLBACK_COLUMNS,
    rows: stdout?.rows ?? FALLBACK_ROWS,
  };
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => readSize(stdout));

  useEffect(() => {
    if (stdout === undefined) return;
    const onResize = (): void => {
      setSize(readSize(stdout));
    };
    stdout.on("resize", onResize);
    onResize();
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}
