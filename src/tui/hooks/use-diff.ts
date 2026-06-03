import { useEffect, useState } from "react";
import { getWorkingTreeDiff, type DiffResult } from "../git-diff.js";

export type UseDiffArgs = {
  cwd: string;
  active: boolean;
  refreshKey: number;
};

export type DiffState = {
  result: DiffResult | null;
  loading: boolean;
};

export function useDiff({ cwd, active, refreshKey }: UseDiffArgs): DiffState {
  const [result, setResult] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    getWorkingTreeDiff(cwd)
      .then((next) => {
        if (!cancelled) setResult(next);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, active, refreshKey]);

  return { result, loading };
}
