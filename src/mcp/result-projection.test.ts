import { describe, expect, test } from "bun:test";
import {
  applyMcpResultProjection,
  MCP_DEFAULT_ENTITY_FIELDS,
  projectMcpJsonValue,
} from "./result-projection.js";

const ISSUE = {
  id: "issue-uuid",
  identifier: "CL-9495",
  url: "https://linear.app/corbits/issue/CL-9495",
  title: "Project MCP results",
  status: {
    id: "state-1",
    name: "In Progress",
    type: "started",
    color: "#f00",
  },
  description: "# long body that must not echo",
  body: "also not this",
  extra: { nested: "drop me" },
};

describe("projectMcpJsonValue", () => {
  test("write-shaped record keeps id url status title and drops the body", () => {
    const projected = projectMcpJsonValue(ISSUE, MCP_DEFAULT_ENTITY_FIELDS);
    expect(projected).toEqual({
      id: "issue-uuid",
      identifier: "CL-9495",
      url: "https://linear.app/corbits/issue/CL-9495",
      status: { id: "state-1", name: "In Progress", type: "started" },
      title: "Project MCP results",
    });
    expect(JSON.stringify(projected)).not.toContain("long body");
    expect(JSON.stringify(projected)).not.toContain("drop me");
  });

  test("aliases Linear state and name onto status and title", () => {
    const projected = projectMcpJsonValue(
      {
        id: "c1",
        identifier: "CL-1",
        url: "https://linear.app/c1",
        state: { name: "In Review" },
        name: "Label",
        description: "nope",
      },
      MCP_DEFAULT_ENTITY_FIELDS,
    );
    expect(projected).toEqual({
      id: "c1",
      identifier: "CL-1",
      url: "https://linear.app/c1",
      status: { name: "In Review" },
      state: { name: "In Review" },
      title: "Label",
      name: "Label",
    });
  });

  test("list envelope projects each row and keeps pagination siblings", () => {
    const projected = projectMcpJsonValue(
      {
        issues: [
          ISSUE,
          { ...ISSUE, id: "two", identifier: "CL-2", description: "x" },
        ],
        hasNextPage: true,
        cursor: "next",
      },
      MCP_DEFAULT_ENTITY_FIELDS,
    );
    expect(projected).toEqual({
      issues: [
        {
          id: "issue-uuid",
          identifier: "CL-9495",
          url: "https://linear.app/corbits/issue/CL-9495",
          status: { id: "state-1", name: "In Progress", type: "started" },
          title: "Project MCP results",
        },
        {
          id: "two",
          identifier: "CL-2",
          url: "https://linear.app/corbits/issue/CL-9495",
          status: { id: "state-1", name: "In Progress", type: "started" },
          title: "Project MCP results",
        },
      ],
      hasNextPage: true,
      cursor: "next",
    });
  });

  test("explicit fields expand to those keys including description", () => {
    const projected = projectMcpJsonValue(
      ISSUE,
      ["id", "description"],
      false,
      false,
    );
    expect(projected).toEqual({
      id: "issue-uuid",
      description: "# long body that must not echo",
    });
  });
});

describe("applyMcpResultProjection", () => {
  test("save_issue projects text JSON and structured content", () => {
    const result = applyMcpResultProjection({
      serverName: "linear",
      toolName: "save_issue",
      args: { title: "Project MCP results", description: "# long body" },
      blocks: [{ type: "text", text: JSON.stringify(ISSUE) }],
      structuredContent: ISSUE,
    });
    const text = result.blocks[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual({
      id: "issue-uuid",
      identifier: "CL-9495",
      url: "https://linear.app/corbits/issue/CL-9495",
      status: { id: "state-1", name: "In Progress", type: "started" },
      title: "Project MCP results",
    });
    expect(text).not.toContain("long body");
    expect(result.structuredContent).toEqual({
      id: "issue-uuid",
      identifier: "CL-9495",
      url: "https://linear.app/corbits/issue/CL-9495",
      status: { id: "state-1", name: "In Progress", type: "started" },
      title: "Project MCP results",
    });
  });

  test("save_comment drops the body just sent", () => {
    const result = applyMcpResultProjection({
      serverName: "claude_ai_Linear",
      toolName: "save_comment",
      args: { issueId: "CL-9495", body: "done" },
      blocks: [
        {
          type: "text",
          text: JSON.stringify({
            id: "comment-1",
            url: "https://linear.app/comment-1",
            body: "done",
          }),
        },
      ],
    });
    expect(JSON.parse(result.blocks[0]?.text ?? "")).toEqual({
      id: "comment-1",
      url: "https://linear.app/comment-1",
    });
  });

  test("save_issue_label keeps identity fields and drops color dumps", () => {
    const result = applyMcpResultProjection({
      serverName: "acme",
      toolName: "save_issue_label",
      args: { name: "bug" },
      blocks: [
        {
          type: "text",
          text: JSON.stringify({
            id: "label-1",
            name: "bug",
            color: "#ff0000",
            description: "a label description",
          }),
        },
      ],
    });
    expect(JSON.parse(result.blocks[0]?.text ?? "")).toEqual({
      id: "label-1",
      title: "bug",
      name: "bug",
    });
  });

  test("list_issues is short by default", () => {
    const result = applyMcpResultProjection({
      serverName: "linear",
      toolName: "list_issues",
      args: { team: "COR" },
      blocks: [
        {
          type: "text",
          text: JSON.stringify({ issues: [ISSUE], hasNextPage: false }),
        },
      ],
    });
    const parsed = JSON.parse(result.blocks[0]?.text ?? "") as {
      issues: Record<string, unknown>[];
    };
    expect(parsed.issues[0]).not.toHaveProperty("description");
    expect(parsed.issues[0]?.id).toBe("issue-uuid");
    expect(parsed.issues[0]?.title).toBe("Project MCP results");
  });

  test("list_issues with fields keeps the requested expansion", () => {
    const result = applyMcpResultProjection({
      serverName: "linear",
      toolName: "list_issues",
      args: { fields: ["id", "description"] },
      blocks: [
        {
          type: "text",
          text: JSON.stringify({ issues: [ISSUE] }),
        },
      ],
    });
    expect(JSON.parse(result.blocks[0]?.text ?? "")).toEqual({
      issues: [
        {
          id: "issue-uuid",
          description: "# long body that must not echo",
        },
      ],
    });
  });

  test("list_issues with fields all leaves the full payload", () => {
    const payload = { issues: [ISSUE], hasNextPage: false };
    const result = applyMcpResultProjection({
      serverName: "linear",
      toolName: "list_issues",
      args: { fields: "all" },
      blocks: [{ type: "text", text: JSON.stringify(payload) }],
    });
    expect(JSON.parse(result.blocks[0]?.text ?? "")).toEqual(payload);
  });

  test("get_issue is not projected", () => {
    const result = applyMcpResultProjection({
      serverName: "linear",
      toolName: "get_issue",
      args: { id: "CL-9495" },
      blocks: [{ type: "text", text: JSON.stringify(ISSUE) }],
    });
    expect(JSON.parse(result.blocks[0]?.text ?? "")).toEqual(ISSUE);
  });

  test("non-Linear list tools are not projected", () => {
    const payload = { items: [{ id: "1", description: "keep" }] };
    const result = applyMcpResultProjection({
      serverName: "github",
      toolName: "list_issues",
      args: {},
      blocks: [{ type: "text", text: JSON.stringify(payload) }],
    });
    expect(JSON.parse(result.blocks[0]?.text ?? "")).toEqual(payload);
  });
});
