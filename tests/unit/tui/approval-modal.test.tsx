import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { ApprovalModal } from "../../../src/tui/components/approval-modal.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

const PLAN = [
  { file: "src/index.ts", action: "add retry logic", completed: false, deviated: false },
  { file: "src/config.ts", action: "update defaults", completed: false, deviated: false },
];

function renderModal(
  plan = PLAN,
  onApprove = (): void => {},
  onReject = (): void => {},
) {
  return render(<ApprovalModal plan={plan} onApprove={onApprove} onReject={onReject} />);
}

test("renders plan step files and actions", () => {
  const { lastFrame } = renderModal();
  expect(lastFrame()).toContain("src/index.ts");
  expect(lastFrame()).toContain("add retry logic");
  expect(lastFrame()).toContain("src/config.ts");
  expect(lastFrame()).toContain("update defaults");
});

test("renders (no steps) when plan is empty", () => {
  const { lastFrame } = renderModal([]);
  expect(lastFrame()).toContain("(no steps)");
});

test("renders approve and reject hints", () => {
  const { lastFrame } = renderModal();
  expect(lastFrame()).toContain("Approve");
  expect(lastFrame()).toContain("Reject");
});

test("Enter calls onApprove", async () => {
  let approved = false;
  const { stdin } = renderModal(PLAN, () => { approved = true; });
  stdin.write("\r");
  await tick();
  expect(approved).toBe(true);
});

test("Escape calls onReject", async () => {
  let rejected = false;
  const { stdin } = renderModal(PLAN, undefined, () => { rejected = true; });
  stdin.write("\x1B");
  await tick();
  expect(rejected).toBe(true);
});

test("Enter does not call onReject", async () => {
  let rejected = false;
  const { stdin } = renderModal(PLAN, undefined, () => { rejected = true; });
  stdin.write("\r");
  await tick();
  expect(rejected).toBe(false);
});

test("Escape does not call onApprove", async () => {
  let approved = false;
  const { stdin } = renderModal(PLAN, () => { approved = true; });
  stdin.write("\x1B");
  await tick();
  expect(approved).toBe(false);
});

test("accepts a width prop without error", () => {
  const { lastFrame } = render(
    <ApprovalModal plan={PLAN} onApprove={() => {}} onReject={() => {}} width={80} />,
  );
  expect(lastFrame()).toContain("src/index.ts");
  expect(lastFrame()).toContain("add retry logic");
});
