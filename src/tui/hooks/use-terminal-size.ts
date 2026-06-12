import { useStdout } from "ink";
import { useEffect, useState } from "react";

export type TerminalSize = { columns: number; rows: number };

const FALLBACK_COLUMNS = 80;
const FALLBACK_ROWS = 24;
const RESIZE_DEBOUNCE_MS = 50;

function readSize(stdout: NodeJS.WriteStream | undefined): TerminalSize {
  return {
    columns: stdout?.columns ?? FALLBACK_COLUMNS,
    rows: stdout?.rows ?? FALLBACK_ROWS,
  };
}

type DebouncedFunction<T extends (...args: unknown[]) => void> = {
  (...args: Parameters<T>): void;
  cleanup: () => void;
};

export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delayMs: number
): DebouncedFunction<T> {
  let timeoutId: NodeJS.Timeout | undefined;

  const debouncedFn = (...args: Parameters<T>) => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = undefined;
    }, delayMs);
  };

  debouncedFn.cleanup = () => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  };

  return debouncedFn;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => readSize(stdout));

  useEffect(() => {
    if (stdout === undefined) return;

    const debouncedSetSize = debounce((): void => {
      setSize(readSize(stdout));
    }, RESIZE_DEBOUNCE_MS);

    stdout.on("resize", debouncedSetSize);
    debouncedSetSize();

    return () => {
      stdout.off("resize", debouncedSetSize);
      debouncedSetSize.cleanup();
    };
  }, [stdout]);

  return size;
}
