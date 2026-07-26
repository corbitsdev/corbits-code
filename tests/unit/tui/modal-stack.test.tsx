import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { ModalStack, type ModalStackProps } from "../../../src/tui/components/modal-stack.js";
import type { ApprovalOutcome, PermissionRequest } from "../../../src/permission/types.js";
import type { PlanStep } from "../../../src/tui/use-stream.js";
import type { AgentProvider } from "../../../src/tui/components/agent-modal.js";
import type { ActiveApproval } from "../../../src/tui/hooks/use-gates.js";

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

const PLAN_APPROVAL = { id: 1, kind: "plan", plan: PLAN } satisfies ActiveApproval;
const OPERATOR_APPROVAL = { id: 2, kind: "operator", ...OPERATOR } satisfies ActiveApproval;
const PERMISSION_APPROVAL = {
  id: 3,
  kind: "permission",
  request: PERMISSION,
  timeoutMs: null,
} satisfies ActiveApproval;

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
    activeEffort: undefined,
    onAgentApply: () => {},
    onAgentPersistDefault: () => {},
    onAgentSaveProvider: () => ({ ok: true }),
    onAgentDeleteProvider: () => {},
    onCloseAgentModal: () => {},
    activeApproval: null,
    onApprove: () => {},
    onReject: () => {},
    onSelectOperator: () => {},
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
  const { lastFrame } = render(<ModalStack {...base()} activeApproval={PLAN_APPROVAL} />);
  expect(lastFrame()).toContain("Plan Review");
  expect(lastFrame()).toContain("src/index.ts");
});

test("ApprovalModal does not render when pendingPlan is null", () => {
  const { lastFrame } = render(<ModalStack {...base()} activeApproval={null} />);
  expect(lastFrame()).not.toContain("Plan Review");
});

test("ApprovalModal Enter calls onApprove", async () => {
  let approved = false;
  const { stdin } = render(
    <ModalStack {...base()} activeApproval={PLAN_APPROVAL} onApprove={() => { approved = true; }} />
  );
  await tick();
  stdin.write("\r");
  await tick();
  expect(approved).toBe(true);
});

test("ApprovalModal Escape calls onReject", async () => {
  let rejected = false;
  const { stdin } = render(
    <ModalStack {...base()} activeApproval={PLAN_APPROVAL} onReject={() => { rejected = true; }} />
  );
  await tick();
  stdin.write("\x1B");
  await tick();
  expect(rejected).toBe(true);
});

test("OperatorModal renders for an active operator approval", () => {
  const { lastFrame } = render(<ModalStack {...base()} activeApproval={OPERATOR_APPROVAL} />);
  expect(lastFrame()).toContain("Which approach?");
  expect(lastFrame()).toContain("Option A");
  expect(lastFrame()).toContain("Option B");
});

test("OperatorModal does not render without an active approval", () => {
  const { lastFrame } = render(<ModalStack {...base()} activeApproval={null} />);
  expect(lastFrame()).not.toContain("Which approach?");
});

test("OperatorModal Enter calls onSelectOperator with the active ID and selected option", async () => {
  let selected: { id: number; index: number } | null = null;
  const { stdin } = render(
    <ModalStack
      {...base()}
      activeApproval={OPERATOR_APPROVAL}
      onSelectOperator={(id, result) => {
        selected = { id, index: result.kind === "option" ? result.index : -1 };
      }}
    />
  );
  await tick();
  stdin.write("\r");
  await tick();
  expect(selected).toEqual({ id: OPERATOR_APPROVAL.id, index: 0 });
});

const EFFORT_PROVIDERS: AgentProvider[] = [
  { name: "openai", baseURL: "https://api.openai.com/v1", models: ["gpt-5.1"] },
];

test("AgentModal advances to the effort step and applies the chosen effort", async () => {
  let applied: { provider: string; model: string; effort: string } | null = null;
  const { lastFrame, stdin } = render(
    <ModalStack
      {...base()}
      agentModalOpen
      agentProviders={EFFORT_PROVIDERS}
      activeProvider="openai"
      activeModel="gpt-5.1"
      onAgentApply={(provider, model, effort) => {
        applied = { provider, model, effort };
      }}
    />,
  );
  await tick();
  stdin.write("\r"); // provider -> model
  await tick();
  stdin.write("\r"); // model -> effort
  await tick();
  expect(lastFrame()).toContain("reasoning effort");
  expect(lastFrame()).not.toContain("Default (no override)");
  stdin.write("\x1B[A"); // medium -> low
  await tick();
  stdin.write("\x1B[A"); // low -> minimal
  await tick();
  stdin.write("\r"); // apply
  await tick();
  expect(applied).toEqual({ provider: "openai", model: "gpt-5.1", effort: "minimal" });
});

test("AgentModal effort step 'd' persists the chosen effort as default", async () => {
  let persisted: { effort: string | undefined } | null = null;
  const { stdin } = render(
    <ModalStack
      {...base()}
      agentModalOpen
      agentProviders={EFFORT_PROVIDERS}
      activeProvider="openai"
      activeModel="gpt-5.1"
      onAgentPersistDefault={(_provider, _model, effort) => {
        persisted = { effort };
      }}
    />,
  );
  await tick();
  stdin.write("\r"); // provider -> model
  await tick();
  stdin.write("\r"); // model -> effort (cursor starts on medium)
  await tick();
  stdin.write("[B"); // medium -> high
  await tick();
  stdin.write("d"); // persist the chosen effort
  await tick();
  expect(persisted).toEqual({ effort: "high" });
});

test("PermissionModal renders for an active permission approval", () => {
  const { lastFrame } = render(<ModalStack {...base()} activeApproval={PERMISSION_APPROVAL} />);
  expect(lastFrame()).toContain("Approval needed");
  expect(lastFrame()).toContain("npm test");
});

test("PermissionModal does not render without an active approval", () => {
  const { lastFrame } = render(<ModalStack {...base()} activeApproval={null} />);
  expect(lastFrame()).not.toContain("Approval needed");
});

test("PermissionModal '2' resolves the active ID with an accept-once outcome", async () => {
  let resolution: { id: number; outcome: ApprovalOutcome } | null = null;
  const { stdin } = render(
    <ModalStack
      {...base()}
      activeApproval={PERMISSION_APPROVAL}
      onResolvePermission={(id, outcome) => { resolution = { id, outcome }; }}
    />
  );
  await tick();
  stdin.write("2");
  await tick();
  expect(resolution).toEqual({ id: PERMISSION_APPROVAL.id, outcome: { allow: true } });
});

test("PermissionModal Escape resolves the active ID with reject outcome", async () => {
  let resolution: { id: number; outcome: ApprovalOutcome } | null = null;
  const { stdin } = render(
    <ModalStack
      {...base()}
      activeApproval={PERMISSION_APPROVAL}
      onResolvePermission={(id, outcome) => { resolution = { id, outcome }; }}
    />
  );
  await tick();
  stdin.write("\x1B");
  await tick();
  expect(resolution).toEqual({ id: PERMISSION_APPROVAL.id, outcome: { allow: false } });
});

test("one keypress reaches only the active approval modal", async () => {
  let planApprovals = 0;
  let operatorSelections = 0;
  const { lastFrame, stdin } = render(
    <ModalStack
      {...base()}
      activeApproval={PLAN_APPROVAL}
      onApprove={() => { planApprovals += 1; }}
      onSelectOperator={() => { operatorSelections += 1; }}
    />,
  );
  await tick();

  expect(lastFrame()).toContain("Plan Review");
  expect(lastFrame()).not.toContain("Which approach?");
  stdin.write("\r");
  await tick();

  expect(planApprovals).toBe(1);
  expect(operatorSelections).toBe(0);
});


test("consecutive operator approvals reset modal selection state", async () => {
  let selected: { id: number; index: number } | null = null;
  const first = OPERATOR_APPROVAL;
  const second = { ...OPERATOR_APPROVAL, id: 4 } satisfies ActiveApproval;
  const props = {
    ...base(),
    activeApproval: first,
    onSelectOperator: (id: number, result: Parameters<ModalStackProps["onSelectOperator"]>[1]) => {
      selected = { id, index: result.kind === "option" ? result.index : -1 };
    },
  };
  const { rerender, stdin } = render(<ModalStack {...props} />);
  await tick();
  stdin.write("\x1B[B");
  await tick();

  rerender(<ModalStack {...props} activeApproval={second} />);
  await tick();
  stdin.write("\r");
  await tick();

  expect(selected).toEqual({ id: second.id, index: 0 });
});