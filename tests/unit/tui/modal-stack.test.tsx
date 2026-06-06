import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { ModalStack, type ModalStackProps } from "../../../src/tui/components/modal-stack.js";
import type { ApprovalOutcome, PermissionRequest } from "../../../src/permission/types.js";
import type { PlanStep } from "../../../src/tui/use-stream.js";
import type { AgentProvider } from "../../../src/tui/components/agent-modal.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

const PLAN: PlanStep[] = [
  { file: "src/index.ts", action: "add retry logic", completed: false, deviated: false },
];

const OPERATOR = { question: "Which approach?", options: ["Option A", "Option B"] };

const PERMISSION: PermissionRequest = {
  tool: "run_shell",
  action: "Run shell command",
  subject: "npm test",
  scopes: [{ id: "prefix-1", label: "Always allow npm *", pattern: "npm *" }],
};

const PROVIDERS: AgentProvider[] = [];

function base(): ModalStackProps {
  return {
    hooks: [],
    hookPanelOpen: false,
    helpOpen: false,
    onCloseHelp: () => {},
    agentModalOpen: false,
    agentProviders: PROVIDERS,
    activeProvider: "openai",
    activeModel: "gpt-4o",
    onAgentApply: () => {},
    onAgentPersistDefault: () => {},
    onAgentSaveProvider: () => ({ ok: true }),
    onAgentDeleteProvider: () => {},
    onCloseAgentModal: () => {},
    pendingPlan: null,
    onApprove: () => {},
    onReject: () => {},
    pendingOperator: null,
    onSelectOperator: () => {},
    pendingPermission: null,
    onResolvePermission: () => {},
  };
}

test("HookPanel renders when hookPanelOpen is true", () => {
  const { lastFrame } = render(<ModalStack {...base()} hookPanelOpen hooks={[]} />);
  expect(lastFrame()).toContain("hooks");
});

test("HookPanel does not render when hookPanelOpen is false", () => {
  const { lastFrame } = render(<ModalStack {...base()} hookPanelOpen={false} />);
  expect(lastFrame()).not.toContain("hooks");
});

test("HelpOverlay renders when helpOpen is true", () => {
  const { lastFrame } = render(<ModalStack {...base()} helpOpen />);
  expect(lastFrame()).toContain("Keyboard Shortcuts");
});

test("HelpOverlay does not render when helpOpen is false", () => {
  const { lastFrame } = render(<ModalStack {...base()} helpOpen={false} />);
  expect(lastFrame()).not.toContain("Keyboard Shortcuts");
});

test("HelpOverlay Enter calls onCloseHelp", async () => {
  let closed = false;
  const { stdin } = render(<ModalStack {...base()} helpOpen onCloseHelp={() => { closed = true; }} />);
  await tick();
  stdin.write("\r");
  await tick();
  expect(closed).toBe(true);
});

test("ApprovalModal renders when pendingPlan is non-null", () => {
  const { lastFrame } = render(<ModalStack {...base()} pendingPlan={PLAN} />);
  expect(lastFrame()).toContain("Plan Review");
  expect(lastFrame()).toContain("src/index.ts");
});

test("ApprovalModal does not render when pendingPlan is null", () => {
  const { lastFrame } = render(<ModalStack {...base()} pendingPlan={null} />);
  expect(lastFrame()).not.toContain("Plan Review");
});

test("ApprovalModal Enter calls onApprove", async () => {
  let approved = false;
  const { stdin } = render(
    <ModalStack {...base()} pendingPlan={PLAN} onApprove={() => { approved = true; }} />
  );
  await tick();
  stdin.write("\r");
  await tick();
  expect(approved).toBe(true);
});

test("ApprovalModal Escape calls onReject", async () => {
  let rejected = false;
  const { stdin } = render(
    <ModalStack {...base()} pendingPlan={PLAN} onReject={() => { rejected = true; }} />
  );
  await tick();
  stdin.write("\x1B");
  await tick();
  expect(rejected).toBe(true);
});

test("OperatorModal renders when pendingOperator is non-null", () => {
  const { lastFrame } = render(<ModalStack {...base()} pendingOperator={OPERATOR} />);
  expect(lastFrame()).toContain("Operator Question");
  expect(lastFrame()).toContain("Which approach?");
  expect(lastFrame()).toContain("Option A");
  expect(lastFrame()).toContain("Option B");
});

test("OperatorModal does not render when pendingOperator is null", () => {
  const { lastFrame } = render(<ModalStack {...base()} pendingOperator={null} />);
  expect(lastFrame()).not.toContain("Operator Question");
});

test("OperatorModal Enter calls onSelectOperator with selected index", async () => {
  let selected: number | null = null;
  const { stdin } = render(
    <ModalStack
      {...base()}
      pendingOperator={OPERATOR}
      onSelectOperator={(i) => { selected = i; }}
    />
  );
  await tick();
  stdin.write("\r");
  await tick();
  expect(selected).toBe(0);
});

test("PermissionModal renders when pendingPermission is non-null", () => {
  const { lastFrame } = render(<ModalStack {...base()} pendingPermission={PERMISSION} />);
  expect(lastFrame()).toContain("Approval needed");
  expect(lastFrame()).toContain("npm test");
});

test("PermissionModal does not render when pendingPermission is null", () => {
  const { lastFrame } = render(<ModalStack {...base()} pendingPermission={null} />);
  expect(lastFrame()).not.toContain("Approval needed");
});

test("PermissionModal Enter calls onResolvePermission with allow outcome", async () => {
  let outcome: ApprovalOutcome | null = null;
  const { stdin } = render(
    <ModalStack
      {...base()}
      pendingPermission={PERMISSION}
      onResolvePermission={(o) => { outcome = o; }}
    />
  );
  await tick();
  stdin.write("\r");
  await tick();
  expect(outcome).toEqual({ allow: true });
});

test("PermissionModal Escape calls onResolvePermission with reject outcome", async () => {
  let outcome: ApprovalOutcome | null = null;
  const { stdin } = render(
    <ModalStack
      {...base()}
      pendingPermission={PERMISSION}
      onResolvePermission={(o) => { outcome = o; }}
    />
  );
  await tick();
  stdin.write("\x1B");
  await tick();
  expect(outcome).toEqual({ allow: false });
});
