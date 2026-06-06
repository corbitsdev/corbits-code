declare module "@intx/log" {
  export function getLogger(category: string[]): {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  export function configureSync(config: unknown): void;
  export function resetSync(): void;
  export function getConfig(): unknown;
  export function setup(options: unknown): Promise<void>;
  export type SetupOptions = unknown;
}
