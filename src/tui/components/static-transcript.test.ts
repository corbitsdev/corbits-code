import { describe, expect, test } from "bun:test";
import { partitionSettledTurns } from "./static-transcript.js";
import type { ContentBlock, ContentBlockData } from "../use-stream.js";

function asBlock(data: ContentBlockData & { id: string }): ContentBlock {
  return data as ContentBlock;
}

function userBlock(id: string, content: string): ContentBlock {
  return asBlock({ type: "user", id, content });
}

function textBlock(id: string, content: string): ContentBlock {
  return asBlock({ type: "text", id, content });
}

describe("partitionSettledTurns", () => {
  test("returns no turns for an empty stream", () => {
    const result = partitionSettledTurns([], false);
    expect(result.settled).toEqual([]);
    expect(result.tail).toEqual([]);
  });

  test("groups a single turn as settled when nothing is in flight", () => {
    const blocks = [userBlock("u1", "hi"), textBlock("t1", "hello")];
    const result = partitionSettledTurns(blocks, false);
    expect(result.settled).toEqual([blocks]);
    expect(result.tail).toEqual([]);
  });

  test("holds the last turn back as the tail while in flight", () => {
    const turn1 = [userBlock("u1", "first"), textBlock("t1", "reply one")];
    const turn2 = [userBlock("u2", "second"), textBlock("t2", "reply two")];
    const result = partitionSettledTurns([...turn1, ...turn2], true);
    expect(result.settled).toEqual([turn1]);
    expect(result.tail).toEqual(turn2);
  });

  test("commits every turn once the run settles", () => {
    const turn1 = [userBlock("u1", "first"), textBlock("t1", "reply one")];
    const turn2 = [userBlock("u2", "second"), textBlock("t2", "reply two")];
    const result = partitionSettledTurns([...turn1, ...turn2], false);
    expect(result.settled).toEqual([turn1, turn2]);
    expect(result.tail).toEqual([]);
  });

  test("treats blocks before the first user message as their own leading turn", () => {
    const leading = [textBlock("t0", "resumed banner")];
    const turn1 = [userBlock("u1", "hi"), textBlock("t1", "reply")];
    const result = partitionSettledTurns([...leading, ...turn1], true);
    expect(result.settled).toEqual([leading]);
    expect(result.tail).toEqual(turn1);
  });

  test("keeps a lone in-flight turn as the tail with no settled turns", () => {
    const turn1 = [userBlock("u1", "hi")];
    const result = partitionSettledTurns(turn1, true);
    expect(result.settled).toEqual([]);
    expect(result.tail).toEqual(turn1);
  });
});
