---
name: scribe
description: Maintain product, architecture, and implementation docs — routes input, detects gaps, and interviews for completeness
---

# Scribe

Use this skill to maintain documentation across multiple documents that represent different levels of abstraction. When the user provides input, analyze it and route it to the correct document. Scribe is not a passive filing system — after recording what the user provides, it actively identifies gaps, checks cross-document consistency, and asks targeted questions to strengthen the documentation.

## Document Discovery

Before processing input, locate the documentation files:

1. Search for existing files matching `PRODUCT.md`, `ARCHITECTURE.md`, and `IMPLEMENTATION.md` (case-insensitive) in:
   - Repository root
   - `docs/` directory

2. If documents exist, use their locations. If multiple matches exist for the same type, prefer the repository root.

3. If no documents exist, use these defaults when creating new ones:
   - `PRODUCT.md` in repository root
   - `ARCHITECTURE.md` in repository root
   - `IMPLEMENTATION.md` in repository root

## Document Types

**Product** - Product-level documentation

- What we're building and why
- User-facing value propositions
- Vision and goals
- Target users and use cases
- Business justification

**Architecture** - System architecture documentation

- How the system is structured
- Components and their relationships
- Abstractions and interfaces
- Data flow and control flow
- Design decisions that are technology-agnostic

**Implementation** - Implementation documentation

- Specific technology choices
- Protocols and formats
- Libraries and frameworks
- Concrete technical details
- Configuration and deployment specifics

## Using the Question Tool

Throughout this skill, you will use `ask_operator` to interact with the user. It takes a short `question` and an array of short option labels (strings). The operator picks one, types a custom answer, or dismisses.

**Key mechanics:**

- Independent questions are parallel `ask_operator` calls in the same turn — not one call with a `questions` array
- Options are short labels only. Put trade-offs, document routing, and "like [similar feature]" context in the transcript before the tool call
- Do not invent `{ label, description }` objects, `header`, or `multiple: true` — those are not this tool
- If the tool rejects a label as too long, put the essay in the transcript and retry with a shorter label
- Make options context-aware based on information you already have

**When to provide context-aware options:**

- Reference similar features, patterns, or components already documented
- Suggest options based on answers from previous interactions in the session
- Use project-specific terminology from existing documents
- When no patterns exist (empty/minimal documents), provide general options as fallbacks

**Example:** transcript first, then two parallel calls.

PRODUCT.md already treats "reports" as a user-facing benefit; ARCHITECTURE.md has latency targets for other services.

```
ask_operator({
  question: "Is 'fast and reliable' a user-facing promise or a system design requirement?",
  options: [
    "User-facing promise",
    "System design requirement",
    "Both"
  ]
})

ask_operator({
  question: "Does 'fast' have a concrete target?",
  options: [
    "Under 5 seconds",
    "Different target",
    "No specific target"
  ]
})
```

Each call returns the selected label (or the operator's custom text).


## Execution Steps

### Step 0: Document Discovery and Reading

Before classifying input, locate and read the existing documentation files to learn project-specific vocabulary and patterns. This information will be used throughout all subsequent steps for context-aware questioning.

1. Search for existing files matching `PRODUCT.md`, `ARCHITECTURE.md`, and `IMPLEMENTATION.md` (case-insensitive) in repository root and `docs/` directory
2. Read all existing documents to extract:
   - Key terms and component names
   - Patterns in how features are described
   - Existing constraints, limits, or policies
   - Similar features that can serve as templates
3. If documents are empty or minimal, note that general options will be needed instead of context-aware ones

### Step 1: Analyze Input

Read the user's input and determine which category it falls into. Classification is based on two sources: general heuristics and project-specific signals learned from existing documents (Step 0).

**General heuristics:**

_Product signals:_

- Describes user needs or problems
- Explains value or benefits
- Discusses market or competitive positioning
- Uses language like "users can", "enables", "provides value"
- Talks about goals without specifying how

_Architecture signals:_

- Describes components or modules
- Explains how parts interact
- Defines abstractions or interfaces
- Discusses system properties without naming specific technologies
- Technology-agnostic design decisions

_Implementation signals:_

- Names specific technologies, protocols, or formats
- Describes wire formats or API specifications
- Specifies configuration details
- Uses language like "uses", "built on", "implemented with"
- Concrete technical choices

**Project-specific signals:**

Read the existing documents to learn the project's vocabulary. Extract key terms, component names, and patterns that indicate document ownership. For example:

- If the architecture document discusses "the kernel" and "agents", mentions of these terms suggest architectural content
- If the implementation document discusses "SMTP" and "IMAP", mentions of email protocols suggest implementation content
- If the product document discusses "wallets" as a user-facing feature, wallet mentions in a value context suggest product content

Use these learned signals alongside general heuristics. Project-specific vocabulary takes precedence when it provides a clear signal.

### Step 2: Classify and Deepen

If the categorization is clear, proceed to update the appropriate document.

If the input is ambiguous or spans multiple categories, do not simply ask "which document?" Instead, use `ask_operator` to interview the user and decompose the input into distinct claims that can each be routed precisely:

1. Explain what makes the input ambiguous — identify the product, architecture, and/or implementation aspects you see in it.
2. Use `ask_operator` to ask targeted questions that separate those aspects. Based on the context you have from existing documents (Step 0) and the user's input, provide relevant options that help clarify the intent.

**If documents have content with patterns to reference:**

- When user mentions "fast and reliable", reference existing performance promises or design constraints in the transcript, then ask with short labels:
  - "User-facing promise"
  - "System design requirement"
  - "Both"
- When user mentions a component name, reference similar components in the transcript, then ask:
  - "User-facing"
  - "Internal abstraction"

**If documents are empty/minimal (no patterns to reference):**

- Provide general options without specific references:
  - "User-facing promise"
  - "System design requirement"
  - "Both"

3. Route each extracted piece to its appropriate document. A single user statement may result in updates to multiple documents.

### Step 3: Update Document

Read the target document to understand its current structure and content.

Determine where in the document the new content belongs:

- Does it extend an existing section?
- Does it require a new section?
- Does it modify existing content?

Make the update, maintaining the document's existing style and structure.

After updating, assess whether the change is **significant**. A change is significant if it:

- Introduces a new concept, component, or section
- Contradicts or substantially revises existing content
- Adds a top-level capability or design decision

If the change is minor — extending an existing section with more detail, fixing wording, adding a clarification — skip Steps 4 and 5 and proceed directly to Step 6.

### Step 4: Cross-Document Consistency

_Only for significant updates._

Read the other two documents and check whether the new content implies entries that should exist in sibling documents but don't. Common patterns to look for:

- A new architecture component with no corresponding product justification
- A new product capability with no architectural description of how it works
- An implementation detail referencing a component not described in architecture
- A product goal with no implementation approach mentioned

If gaps are found, use `ask_operator` to present them as a batch of 2-4 questions. Based on the context from existing documents (Step 0) and the change just made, provide specific, relevant options.

**Example with existing patterns:**

If you just added an export service to ARCHITECTURE.md, and PRODUCT.md has no mention of exports:

> I updated ARCHITECTURE.md with the export service. I noticed some potential gaps in other documents.

Use `ask_operator` with:

- Question 1: "Should PRODUCT.md describe data export as a user-facing capability?"
  - **If PRODUCT.md has similar features**: "Add as data-access capability" / "Fold into reporting"
  - **If PRODUCT.md is minimal**: "Yes, add as user-facing" / "No, internal only"
- Question 2: "How should IMPLEMENTATION.md describe export generation?"
  - **If IMPLEMENTATION.md describes other services**: "Same approach as [service]" / "Different approach"
  - **If IMPLEMENTATION.md is minimal**: "Name the library" / "Defer for now"

For each question the user answers, update the corresponding document before proceeding.

### Step 5: Gap Detection and Completeness

_Only for significant updates._

Scan the updated document for weaknesses:

- Concepts referenced but not elaborated
- Sections that are thin relative to their importance
- Missing failure modes, edge cases, or constraints
- Decisions stated without rationale

Use `ask_operator` to present 2-4 probing questions as a batch. Focus on non-obvious gaps — things the user might not think to document unprompted. Based on the content just added, questions already answered in this session, and patterns from existing documentation, provide specific, contextual options.

**Example with existing patterns:**

If you just added an export service to ARCHITECTURE.md:

- Question 1: "What happens when an export fails mid-generation?"
  - **If other services have retry logic**: "Automatic retry, like [service]" / "User must re-trigger" / "Save partial for resume"
  - **If no retry patterns exist**: "Automatic retry" / "User must re-trigger" / "Save partial for resume"
- Question 2: "Are there size or rate limits on exports?"
  - **If similar features have limits**: "Same limits as [feature]" / "Different limits" / "No hard limits"
  - **If no limits documented**: "10k rows / 100MB max" / "No hard limits" / "To be determined"
- Question 3: "Who has permission to trigger exports?"
  - **If docs mention role-based access**: "Any authenticated user" / "Admin/owner only" / "Configurable per workspace"
  - **If auth not documented**: "Any authenticated user" / "Role-restricted" / "To be determined"

Update the document with any answers the user provides. If the user declines to answer, move on without pressing.

**User fatigue consideration:** If the user has declined 3 or more gap detection questions in this session, skip remaining gap detection steps unless the user explicitly requests them.

### Step 6: Report

Briefly confirm what was changed and in which document. If Steps 4 or 5 resulted in additional updates, summarize those as well:

> Updated ARCHITECTURE.md: added export service component under "Data Pipeline" section.
> Also updated PRODUCT.md: added data export as a user-facing capability (from consistency check).

## Examples

These examples demonstrate how classification and the active documentation steps work. The specific terms will vary by project.

### Classification

**Input:** "Users can export their data in multiple formats"
**Classification:** Product (describes user-facing capability)

**Input:** "The export service validates permissions before generating files"
**Classification:** Architecture (describes component responsibility and interaction)

**Input:** "Exports are generated as CSV using the fast-csv library"
**Classification:** Implementation (names specific format and library)

### Depth Elicitation (Step 2)

**Input:** "Data export is fast and reliable"
**Classification:** Ambiguous — has both product and architecture aspects.

Instead of asking "which document?", use `ask_operator` to decompose. After reading existing docs (Step 0) and seeing that PRODUCT.md already mentions "reports" as a user-facing feature and ARCHITECTURE.md discusses latency targets for other services:

Use `ask_operator`:

- Question 1: "Is 'fast and reliable' a promise to users or a system design requirement?"
  - Option 1: "User-facing promise"
  - Option 2: "System design requirement"
  - Option 3: "Both"
- Question 2: "Does 'fast' have a concrete target?"
  - Option 1: "Under 5 seconds"
  - Option 2: "Different target"
  - Option 3: "No specific target yet"

If the user selects "Both" and "under 5 seconds", this produces two updates:

- **PRODUCT.md:** Data export completes in under 5 seconds for typical datasets (up to 10k rows).
- **ARCHITECTURE.md:** The export pipeline must meet a 5-second latency target for datasets up to 10k rows.

### Cross-Document Consistency (Step 4)

**Scenario:** User adds "The notification service delivers messages through email, SMS, and push" to ARCHITECTURE.md.

After updating, scribe reads the other documents and finds that PRODUCT.md has no mention of notifications as a user-facing feature, but does mention "alerts" in a different context. IMPLEMENTATION.md describes other third-party integrations using specific provider names.

Use `ask_operator`:

- Question 1: "Should PRODUCT.md describe notifications as a user-facing capability?"
  - Option 1: "Add as a user-facing feature"
  - Option 2: "Fold into existing alerts"
  - Option 3: "Internal only"
- Question 2: "Should IMPLEMENTATION.md specify the notification providers?"
  - Option 1: "Yes — name the provider"
  - Option 2: "Yes — different providers"
  - Option 3: "Not yet"

### Gap Detection (Step 5)

**Scenario:** User adds a new "Authentication" section to ARCHITECTURE.md describing token-based auth with refresh tokens.

After updating, scribe scans the section and identifies gaps. From reading ARCHITECTURE.md (Step 0), scribe notices other sections mention security constraints and timeout values. IMPLEMENTATION.md describes storage mechanisms for other sensitive data.

Use `ask_operator`:

- Question 1: "What happens when a refresh token is revoked?"
  - Option 1: "Signed out immediately"
  - Option 2: "Signed out at next request"
  - Option 3: "Configurable per deployment"
- Question 2: "Is there a maximum session duration?"
  - Option 1: "30 days"
  - Option 2: "Different duration"
  - Option 3: "No hard limit"
- Question 3: "How are tokens stored on the client side?"
  - Option 1: "Same as other secrets"
  - Option 2: "Different storage"
  - Option 3: "Client decides"

## Error Handling

### Document does not exist

If the target document does not exist, use `ask_operator` to ask the user if they want to create it, with context about what type of document it is:

Question: "The [DOCUMENT].md file does not exist. Should I create it?"
Options:

- "Yes, create it"
- "Use a different document"

### Content conflicts

If the new content contradicts existing content, use `ask_operator` to flag it with specific options:

Question: "This conflicts with existing content in [DOCUMENT].md: '[existing content]'. How should I resolve this?"
Options based on the nature of the conflict:

- "Replace with the new content"
- "Keep both, with clarification"
- "Merge the two"

### Unclear scope

If the input is too broad or vague to place in a specific document, use `ask_operator` to narrow it down:

Question: "I'm not sure where '[user input]' belongs. Can you help me place it?"
Options based on what aspects you can detect:

- "PRODUCT.md"
- "ARCHITECTURE.md"
- "IMPLEMENTATION.md"
- "Multiple documents"
