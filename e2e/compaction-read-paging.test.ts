import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import { COMPACTED_PREFIX } from "../src/session/compactor.js";
import {
  closeE2ESession,
  e2ePermissionGate,
  openE2ESession,
  runUntilDone,
  seedFile,
  type E2ESession,
} from "./harness.js";

const WireRequest = type({
  messages: type({ role: "string", content: "unknown" }).array(),
});

// claude-integration resolves a 200k context window, so a 200k-token usage
// frame reports over the 120k auto-compaction threshold.
const TRIGGER_USAGE = {
  input: 200_000,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
};
const LOW_USAGE = {
  input: 100,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
};

function logLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `log line ${i + 1}`).join(
    "\n",
  );
}

async function openFoldSession(): Promise<E2ESession> {
  const session = await openE2ESession({
    permissionGate: e2ePermissionGate(),
    // A tiny tail budget keeps the fold honest: the default 7500-token
    // budget would absorb this small scenario into the live tail and the
    // compactor would correctly no-op.
    compactionShape: { tailBudgetTokens: 10 },
    // Echo the summarized turns verbatim: the spine must exist, and this
    // scenario asserts on the kept live bodies, not the summary text.
    compactionCompletion: async (turns) =>
      turns
        .flatMap((turn) =>
          turn.content.flatMap((block) =>
            block.type === "text" ? [block.text] : [],
          ),
        )
        .join("\n"),
  });
  seedFile(session, "var/log/big.log", `${logLines(80)}\n`);
  return session;
}

function readWindow(offset: number, limit: number) {
  return {
    name: "read",
    args: { path: "var/log/big.log", offset, limit },
  };
}

/** Body of the last inference request the harness routed, as raw text. */
async function lastRequestBody(session: E2ESession): Promise<string> {
  const request = session.harness.scenario.matchedRequests().at(-1);
  if (request === undefined) throw new Error("no routed requests");
  return (request.clone() as unknown as Request).text();
}

/** Warm-up turns so the transcript clears the governor's minimum size. */
async function padTurns(session: E2ESession, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    session.harness.scenario.replyOnce("anthropic", {
      text: `Acknowledged ${i}.`,
      headUsage: LOW_USAGE,
    });
    await runUntilDone(session, `Pad turn ${i}.`);
  }
}

/**
 * One user turn that pages through the log and folds mid-turn: each scripted
 * read reply reports low usage so the governor stays disarmed until the
 * final call, whose 200k usage frame arms the tool.done intercept — the
 * compact+emit batch runs, the delivered continuation re-enters inference,
 * and the last scripted reply answers the post-fold request. Keeping every
 * read inside this turn is what lands the kept windows in the live tail.
 */
async function readChainThenFold(
  session: E2ESession,
  reads: { offset: number }[],
): Promise<void> {
  const last = reads.length - 1;
  reads.forEach((read, i) => {
    session.harness.scenario.replyOnce("anthropic", {
      text: "Reading the next window.",
      toolCalls: [readWindow(read.offset, 20)],
      headUsage: i === last ? TRIGGER_USAGE : LOW_USAGE,
    });
  });
  session.harness.scenario.replyOnce("anthropic", {
    text: "Finished reading the log.",
  });
  await runUntilDone(session, "Page through var/log/big.log.");
}

describe("e2e — automatic compaction keeps the read resume recipe", () => {
  test.serial(
    "distinct read windows survive a fold with bodies and next-offset notices",
    async () => {
      const session = await openFoldSession();
      try {
        await padTurns(session, 2);
        await readChainThenFold(session, [
          { offset: 20 },
          { offset: 40 },
          { offset: 60 },
        ]);

        const body = await lastRequestBody(session);
        const wire = WireRequest.assert(JSON.parse(body));
        // The fold ran: exactly one spine turn leads the compacted context.
        const spines = wire.messages.filter((message) =>
          JSON.stringify(message.content).includes(COMPACTED_PREFIX),
        );
        expect(spines).toHaveLength(1);

        // Each kept window still carries its own body and resume recipe —
        // the summary echoed turn text only, so these strings can only come
        // from the live kept results.
        expect(body).toContain("Use offset=40 to continue");
        expect(body).toContain("Use offset=60 to continue");
        expect(body).toContain("log line 25");
        expect(body).toContain("log line 45");
        // Distinct windows are distinct read keys: nothing was hollowed.
        expect(body).not.toContain("omitted from context");
      } finally {
        await closeE2ESession(session);
      }
    },
    60000,
  );

  test.serial(
    "a verbatim replay stubs the older duplicate and keeps the newest whole",
    async () => {
      const session = await openFoldSession();
      try {
        await padTurns(session, 2);
        await readChainThenFold(session, [
          { offset: 20 },
          { offset: 20 },
          { offset: 60 },
        ]);

        const body = await lastRequestBody(session);
        expect(body).toContain(COMPACTED_PREFIX);
        // The newest copy of the identical window keeps its body and notice;
        // exactly one older duplicate renders as a stub.
        expect(body).toContain("Use offset=40 to continue");
        const stubs = body.match(/omitted from context/g) ?? [];
        expect(stubs).toHaveLength(1);
      } finally {
        await closeE2ESession(session);
      }
    },
    60000,
  );
});
