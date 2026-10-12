import { describe, expect, test } from "bun:test";
import type {
  InferenceSource,
  ReactorAction,
  ReactorDirector,
} from "@intx/types/runtime";

import { withContinuationOAuthRefresh } from "./refresh-inference-source.js";

const baseSource = (id: string): InferenceSource => ({
  id,
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  credentialId: id,
  model: "gpt-4o",
});

describe("withContinuationOAuthRefresh cache", () => {
  test("a second wrap of the same inner director applies the second wrap's sources", async () => {
    const seen: { sources: InferenceSource[]; defaultSource: string }[] = [];
    const agent = {
      setSources(sources: InferenceSource[], defaultSource: string) {
        seen.push({ sources, defaultSource });
      },
    };

    const inner: ReactorDirector = {
      async decide(): Promise<ReactorAction[]> {
        return [{ type: "infer" }];
      },
    };

    const sourcesA = [baseSource("openai")];
    const sourcesB = [baseSource("other")];

    // First wrap with option set A.
    withContinuationOAuthRefresh(inner, {
      getAgent: () => agent,
      sources: sourcesA,
      defaultSource: "openai",
      catalog: [],
    });

    // Second wrap of the SAME inner director with a different option set B.
    const wrapped = withContinuationOAuthRefresh(inner, {
      getAgent: () => agent,
      sources: sourcesB,
      defaultSource: "other",
      catalog: [],
    });

    await wrapped.decide({} as never, {} as never, {} as never);

    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call?.defaultSource).toBe("other");
    expect(call?.sources).toEqual(sourcesB);
  });
});
