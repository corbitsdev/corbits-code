---
name: interview
argument-hint: "<topic>[; <context>]"
description: Conduct an iterative multiple-choice interview using ask_operator. Returns the Q&A inline. Use as a utility when a caller needs structured user input on a topic.
---

# Interview

Gather structured user input on a topic via multiple-choice `ask_operator` questions. Emit the Q&A inline; the caller decides what to do with it.

This is a utility, not a planner. It does not decide what to build, write any files, spawn agents, or invoke other skills.

## Argument

`<topic>[; <context>]`

- **Topic** — what the interview is about
- **Context** (optional) — facts already known. Treat each as an answered dimension; do not re-ask things context settles.

If no topic is given, ask for one with `ask_operator` before proceeding.

## Process

### Identify dimensions to probe

Enumerate the open questions worth asking from the topic and context. Skip dimensions the context already settles. Add domain-specific ones where relevant. There is no fixed dimension list — the topic determines it.

Probe objective and priorities before details. They shape every later question, so anchoring them early prevents reshuffling halfway through.

### Ask with ask_operator

Each question is one `ask_operator` call: `question` (string) plus `options` (array of strings). Fire independent questions together as parallel tool calls in the same turn.

`ask_operator` is single-select per call. The operator can also type a custom answer. There is no multi-select flag — if a dimension genuinely permits several answers, encode the realistic combinations as options, or follow up once the first answer lands.

**No false caps.** `ask_operator` has no skill-invented ceiling on option count, parallel questions per round, or total rounds. Batch every independent dimension you can author now. Drop to one question only when the next question's text or options cannot be written without this answer. Stop when marginal value is low (see below) — never because a made-up quota was hit. If the caller passed an explicit cap, honour it.

**Quality bar for options:**

- Mutually exclusive **short labels** — not "yes / no / maybe"
- Each option a real, defensible choice — not a strawman
- Trade-offs, rationale, and context go in the **preceding transcript reply**, then `ask_operator` with a brief question and brief labels. Do not put essays in the option string — `options` are strings, not `{ label, description }` objects
- Ground options in the topic and context — do not invent generic options when concrete ones exist
- Combination options only when the dimension genuinely permits more than one answer
- If you have a recommendation, put it first and label it

Referencing a prior answer inside a later question's text is fine.

### Decide when to stop

Stop when:

- Every open dimension has been answered or marked out of scope
- Remaining unknowns are details the caller can reasonably decide
- The user has signalled fatigue (declines to choose, short non-substantive custom answers, asks to wrap up)
- The topic has shifted into territory outside this interview's scope

There is no fixed round cap. Stop when the marginal value of another round is low.

### Handle trouble

- **Contradiction with a prior answer.** Ask one clarifying question that surfaces both choices directly. Record the resolution; do not silently overwrite.
- **Custom answer reveals a missing dimension.** Add it to the dimension list and continue.
- **Topic shift.** If the user's answers reframe the topic itself, stop, emit what you have, and tell the caller the topic has changed.
- **No objective to anchor on.** If the user is fundamentally undecided about the topic's objective itself (not just details), stop without a findings list. Tell the caller what you learned, why you stopped, and what they should consider doing instead.

### Return findings

When the interview ends, emit the Q&A inline as a numbered list of question → answer pairs. Format:

```
## Interview findings: <topic>

1. <question>: <answer>
2. <question>: <answer>
3. <question>: <answer (combination)> — <answer>
```

If the user declined some questions or punted a dimension, note it in the same list:

```
4. <question>: deferred (user said "you decide")
```

Do not invent a structured summary on top of this. The caller decides what to do with the findings.

After emitting the findings, stop. Do not load other skills, invoke other agents, or write any file.

## Worked example

**Invocation:** `use_skill(name="interview")` with the topic in the conversation, or `/interview notification system; backend is Node/Postgres, internal users only, must integrate with existing auth`

**Round 1** (three parallel `ask_operator` calls — independent dimensions, so ask together). Trade-offs belong in the transcript before the calls, not in the labels — e.g. "critical vs activity vs re-engagement; never-miss vs real-time vs per-event opt-in; in-app vs email vs webhook."

```
ask_operator({
  question: "What is the primary goal of the notification system?",
  options: [
    "Alert on critical events",
    "Keep users informed of activity",
    "Drive user re-engagement"
  ]
})

ask_operator({
  question: "If you had to pick one, which matters most?",
  options: [
    "Reliability of delivery (recommended)",
    "Latency",
    "User control"
  ]
})

ask_operator({
  question: "Which delivery channels do you want?",
  options: [
    "In-app",
    "Email",
    "In-app + Email",
    "Webhook",
    "All of the above"
  ]
})
```

**Hypothetical answers:** Alert on critical events; Reliability of delivery; In-app + Email.

**Round 2** builds on round 1 (e.g. email cadence, failure handling). Once no obvious questions remain, emit the findings list and stop.

## Style

- Do not lecture between rounds. A short orientation sentence is fine.
- Do not summarize the user's answers back at them mid-interview.
- Do not ask leading questions.

## Anti-patterns

- **Interviewing yourself.** Filling in answers because they "seem obvious" — stop and ask, or note as assumption.
- **Serializing independent questions.** If dimensions do not depend on each other, ask them in parallel.
- **Inventing quotas.** Do not stop or thin options because of a made-up question or option count.
- **Asking about everything.** Prune dimensions that do not apply.
- **Treating a custom answer as failure.** Custom answers are signal.
- **Forgetting context.** Read it. Do not re-ask things the context already settled.
- **Writing files.** This skill never writes a file. The output is conversational.
- **Invoking other skills or agents.** Emit findings and stop.
