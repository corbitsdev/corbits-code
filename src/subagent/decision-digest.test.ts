import { describe, expect, test } from "bun:test";
import {
  digestCollectedReports,
  MAILBOX_DIGEST_TOTAL_CHARS,
} from "./fleet-dry-drive.js";
import {
  formatWorkerDecisionBlock,
  parseWorkerDecision,
} from "./decision-digest.js";

function envelopeWithDecision(decision: string): string {
  return [
    "## Summary",
    "Did the work.",
    "",
    "## Findings",
    "Some findings.",
    "",
    "## Blockers",
    "None.",
    "",
    "## Paths",
    "src/a.ts",
    "",
    decision,
  ].join("\n");
}

describe("parseWorkerDecision", () => {
  test("missing block reports missing", () => {
    expect(parseWorkerDecision("## Summary\nDone.")).toEqual({
      kind: "missing",
    });
    expect(parseWorkerDecision(undefined)).toEqual({ kind: "missing" });
  });

  test("invalid JSON reports invalid without inferring from prose", () => {
    const text = [
      "The work passed all checks.",
      "```decision:v1",
      "{ not json",
      "```",
    ].join("\n");
    expect(parseWorkerDecision(text).kind).toBe("invalid");
  });

  test("schema violation reports invalid without inferring from prose", () => {
    const text = [
      "verdict: pass (prose claims success)",
      "```decision:v1",
      JSON.stringify({ version: "1", verdict: "definitely-pass" }),
      "```",
    ].join("\n");
    const parsed = parseWorkerDecision(text);
    expect(parsed.kind).toBe("invalid");
  });

  test("valid block parses", () => {
    const block = formatWorkerDecisionBlock({
      version: "1",
      verdict: "pass",
      required_action: "none",
      critical_findings: ["a"],
      checks: [{ name: "unit", status: "passed" }],
    });
    const parsed = parseWorkerDecision(block);
    expect(parsed.kind).toBe("ok");
  });
});

describe("decision digest", () => {
  test("legacy report without a block stays unknown", async () => {
    const [digest] = await digestCollectedReports([
      {
        agent_id: "legacy",
        status: "done",
        report: "## Summary\nDid it.\n\n## Findings\nNone.\n",
      },
    ]);
    expect(digest?.decision_verdict).toBe("unknown");
    expect(digest?.decision_source).toBe("missing");
    expect(digest?.status).toBe("done");
    expect(digest?.summary).toContain("Did it.");
  });

  test("missing report is explicitly unavailable and unknown", async () => {
    const [digest] = await digestCollectedReports([
      { agent_id: "gone", status: "done" },
    ]);
    expect(digest?.decision_verdict).toBe("unknown");
    expect(digest?.decision_source).toBe("missing");
    expect(digest?.report_unavailable).toBe(true);
    expect(digest?.report_uri).toBeUndefined();
  });

  test("invalid block never infers facts from prose", async () => {
    const report = [
      "## Summary",
      "All checks passed, ship it.",
      "",
      "```decision:v1",
      "{ broken json",
      "```",
    ].join("\n");
    const [digest] = await digestCollectedReports([
      { agent_id: "bad", status: "done", report },
    ]);
    expect(digest?.decision_verdict).toBe("unknown");
    expect(digest?.decision_source).toBe("invalid");
  });

  test("harness status stays separate from worker claims", async () => {
    const failClaim = formatWorkerDecisionBlock({
      version: "1",
      verdict: "fail",
      required_action: "Fix the regression.",
    });
    const passClaim = formatWorkerDecisionBlock({
      version: "1",
      verdict: "pass",
    });
    const digests = await digestCollectedReports([
      {
        agent_id: "w-done-fail",
        status: "done",
        report: envelopeWithDecision(failClaim),
      },
      {
        agent_id: "w-failed-pass",
        status: "failed",
        error: "boom",
        report: envelopeWithDecision(passClaim),
      },
    ]);
    const doneFail = digests.find((d) => d.agent_id === "w-done-fail");
    const failedPass = digests.find((d) => d.agent_id === "w-failed-pass");
    // done != passed: harness "done" never becomes a worker "pass".
    expect(doneFail?.status).toBe("done");
    expect(doneFail?.decision_verdict).toBe("fail");
    expect(doneFail?.required_action).toContain("Fix the regression.");
    // A worker "pass" claim never rewrites a harness "failed".
    expect(failedPass?.status).toBe("failed");
    expect(failedPass?.decision_verdict).toBe("pass");
  });

  test("failed checks are labeled worker-reported/unverified", async () => {
    const block = formatWorkerDecisionBlock({
      version: "1",
      verdict: "fail",
      required_action: "Repair.",
      critical_findings: ["regression in auth"],
      checks: [{ name: "unit", status: "failed", detail: "3 red" }],
    });
    const [digest] = await digestCollectedReports([
      {
        agent_id: "w-checks",
        status: "done",
        report: envelopeWithDecision(block),
      },
    ]);
    expect(digest?.decision_verdict).toBe("fail");
    expect(digest?.critical_findings).toContain("regression in auth");
    expect(digest?.checks?.length).toBe(1);
    expect(digest?.checks?.[0]).toMatchObject({
      name: "unit",
      status: "failed",
      verification: "worker-reported/unverified",
    });
  });

  test("oversized decision fields clip with a visible signal", async () => {
    const block = formatWorkerDecisionBlock({
      version: "1",
      verdict: "fail",
      required_action: `do it ${"x".repeat(5_000)}`,
      critical_findings: [
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
      ],
      checks: Array.from({ length: 30 }, (_, i) => ({
        name: `check-${i}`,
        status: "passed" as const,
      })),
    });
    const [digest] = await digestCollectedReports([
      {
        agent_id: "w-big",
        status: "done",
        report: envelopeWithDecision(block),
      },
    ]);
    expect(digest?.decision_verdict).toBe("fail");
    expect(digest?.required_action).toContain("more chars omitted");
    expect(digest?.critical_findings).toContain("omitted");
    expect(digest?.checks?.length ?? 0).toBeLessThanOrEqual(10);
  });

  test("failures sort first and the total stays capped with overflow", async () => {
    const failBlock = formatWorkerDecisionBlock({
      version: "1",
      verdict: "fail",
      required_action: "Urgent fix.",
    });
    const passBlock = formatWorkerDecisionBlock({
      version: "1",
      verdict: "pass",
    });
    const reports = [
      {
        agent_id: "w-pass",
        status: "done",
        report: envelopeWithDecision(passBlock),
      },
      {
        agent_id: "w-fail",
        status: "done",
        report: envelopeWithDecision(failBlock),
      },
    ];
    const digests = await digestCollectedReports(reports);
    expect(digests[0]?.agent_id).toBe("w-fail");

    const many = Array.from({ length: 40 }, (_, i) => ({
      agent_id: `w-${i}`,
      status: "done" as const,
      report: `## Summary\n${"y".repeat(2_000)} worker ${i}\n\n${envelopeWithDecision(failBlock)}`,
    }));
    const capped = await digestCollectedReports(many);
    const total = JSON.stringify(capped).length;
    expect(total).toBeLessThanOrEqual(MAILBOX_DIGEST_TOTAL_CHARS);
    const hasOverflow = capped.some((d) => d.overflow !== undefined);
    expect(hasOverflow).toBe(true);
    // The highest-priority failure survives the cap.
    expect(capped[0]?.decision_verdict).toBe("fail");
  });

  test("single-worker 50k description stays within the total cap", async () => {
    const digests = await digestCollectedReports([
      {
        agent_id: "w-huge-desc",
        status: "done",
        description: "d".repeat(50_000),
        report: "## Summary\nDid it.\n",
      },
    ]);
    expect(digests.length).toBe(1);
    expect(JSON.stringify(digests).length).toBeLessThanOrEqual(
      MAILBOX_DIGEST_TOTAL_CHARS,
    );
  });

  test("unavailable spill keeps an explicit unavailability signal", async () => {
    const [digest] = await digestCollectedReports(
      [{ agent_id: "w-noblob", status: "done" }],
      async () => {
        throw new Error("disk full");
      },
    );
    expect(digest?.report_unavailable).toBe(true);
    expect(digest?.report_uri).toBeUndefined();
  });
});
