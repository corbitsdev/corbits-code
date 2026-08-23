---
name: create-issue
description: Create well-structured issues. Linear MCP if available; otherwise ask for GitHub (or another tracker) and remember the preference.
argument-hint: "[description] [--from-doc]"
---

# Create Issue

You are Skywalker. Host is Corbits. This skill is a slash command (`/create-issue`) and is also loadable with `use_skill("create-issue")`. Clarifying questions use `ask_operator`. Do not invent Claude-only tools. Do not invent a Linear REST client.

Create well-structured issues (and, on Linear, projects / project updates / initiatives when the operator asks). Run tracker selection first, then the quality phases, then create on the chosen tracker.

## Tracker selection

Pick the tracker before drafting. Do not skip this.

1. If `mcp__linear__*` tools are available → Linear. Do not ask.
2. Else `read_file` `.corbits/MEMORY.md` and look for a line `Preferred issue tracker:`. If present, use that tracker.
3. Else `ask_operator` with options:
   - GitHub
   - GitLab
   - Linear (enable MCP)
   - Other
     Then persist the choice: DIY with write_file/edit_file — append `Preferred issue tracker: <name>` to `.corbits/MEMORY.md` only. Path tools are the DIY surface; shell writes stay denied. Do not touch anything else.
4. **GitHub** → create with `gh issue create` (title + body) via `run_shell`. If `gh` is missing, tell the operator to install GitHub CLI (`gh`) and stop. Do not invent an HTTP client.
5. **GitLab** → create with `glab issue create` (title + body) via `run_shell` similarly. If `glab` is missing, tell the operator and stop.
6. **Linear without MCP** → stop and tell the operator to enable Linear MCP. Do not invent a Linear REST client.
7. **Other** → `ask_operator` how they file issues, then follow that.

Linear MCP tool names stay `mcp__linear__*` on the Linear path.

## Phase 1: Document Discovery

When the operator provides `--from-doc` or mentions a planning document, search for scribe-managed documents with `search_files` / `read_file` (not Glob):

1. Search for `PRODUCT.md`, `ARCHITECTURE.md`, `IMPLEMENTATION.md` at:
   - Repository root
   - `docs/` directory

2. If no documents are found, `ask_operator`:

   > I couldn't find any planning documents. Do you have a document you'd like me to reference?

3. When a document is found, `read_file` it and extract:
   - Features or work items mentioned
   - Technical context and constraints
   - Scope indicators (timeline mentions, complexity signals)

Use extracted information to:

- Pre-populate issue descriptions with relevant context
- Propose appropriate artifact types based on scope
- Ask targeted follow-up questions for gaps not covered by the document

## Phase 2: Analyze Input (scope)

Determine what the user wants to create:

1. **Explicit request**: User specifies artifact type ("create an issue for...", "create a project for...", "post a project update for...")
2. **From document**: User provides `--from-doc` to extract work items from planning documents
3. **Freeform**: User describes work without specifying type

Project updates are a distinct Linear artifact: they communicate status on an existing project to a non-technical audience and are never inferred from scope. The user must explicitly ask for one. Skip project/initiative/update artifacts on GitHub and GitLab unless the operator explicitly wants an issue-shaped stand-in.

For freeform input, estimate the scope:

| Scope  | Duration  | Artifact                                                              |
| ------ | --------- | --------------------------------------------------------------------- |
| Small  | 1-3 days  | Single issue                                                          |
| Medium | 1-2 weeks | Project with issues (Linear) or a set of issues (GitHub / GitLab)     |
| Large  | Quarter+  | Initiative with projects (Linear) or grouped issues (GitHub / GitLab) |

Present your assessment and `ask_operator` to confirm before proceeding.

## Phase 3: Interview

If information is missing, `ask_operator` with targeted questions. Keep interviews brief and focused.

### For Issues

Required information:

- What problem does this solve or what value does it add?
- How will we know it's done? (acceptance criteria)

Optional:

- Are there technical constraints or dependencies?
- Which team should own this?

### For Projects (Linear)

Required information:

- What is the goal/outcome of this project?
- What is the target timeframe?
- Who should lead this project?

Optional:

- What teams are involved?
- What are the key milestones?

### For Initiatives (Linear)

Required information:

- What strategic objective does this serve?
- Who is the executive owner?
- What projects should be included?

### For Project Updates (Linear)

Required information:

- Which project is this update for? (use `mcp__linear__list_projects` and confirm with the user if the match is not exact)
- What is the project's current health? (on track, at risk, off track, completed, paused)
- What has the project unlocked or enabled since the last update? Describe in terms of capabilities, outcomes, or things that are now possible — not lists of completed tickets.
- What's coming next, framed by user-visible impact?
- Are there any risks or blockers the audience needs to know about? Describe them by impact, not implementation.

Optional:

- Should the update be tied to a specific milestone?

Before drafting, retrieve the most recent prior update with `mcp__linear__get_status_updates` so the new one continues the narrative rather than restating prior progress.

## Phase 4: Draft Content (title + AC)

Create drafts following these conventions.

### Do Not Reference Local Files

Tracker artifacts are read by people who do not share your working directory. Do not include local file paths, line numbers, working-tree-relative paths, or instructions like "see `src/foo.ts`" in titles, descriptions, or comments. Those references rot, are not clickable, and assume context the reader does not have.

Instead:

- Describe the behavior, module, or concept in plain language ("the authentication middleware", "the request retry logic")
- Link to permanent URLs (GitHub permalinks at a specific commit, published documentation) when a precise pointer is required
- Quote the relevant code inline if a short excerpt is needed for context

This applies equally when drafting from planning documents — extract the meaning, do not transcribe paths.

### Specs Belong as Attachments (Linear)

If a spec, design document, or planning artifact needs to be preserved so an implementer can refer to it, attach it to the Linear artifact rather than referencing the local file path:

- Specs that describe an entire project's scope or design attach to the **project**
- Specs that describe a single unit of work attach to the **issue** for that work

Use `mcp__linear__prepare_attachment_upload` followed by `mcp__linear__create_attachment_from_upload` (or `mcp__linear__create_attachment` for URL-based references) to upload the document. Once attached, any reference inside the issue or project description should point to the attached document — never to the original local file path.

On GitHub / GitLab, paste the relevant meaning into the issue body or link a permanent URL. Do not point at local paths.

### Issue Format

**Title**: Clear and actionable. Verb phrases are preferred, but sentences or noun phrases are acceptable when they provide clarity.

- Good: "Add retry logic for failed API calls"
- Good: "Fix race condition in transaction verification"
- Good: "Create market validation track for <product-name>"
- Bad: "API retry" (too vague)
- Bad: "Bug in transactions" (not actionable)

**Description**:

```
# Background

<Context and what triggered this work. Optional for simple tasks.>

# Outcome

<What success looks like, with checkboxes for specific conditions>

- [ ] <Specific, testable condition>
- [ ] <Another condition>
```

For simple tasks, you can omit `# Background` and use only `# Outcome` with checkboxes.

**Labels and Priority**:

- Set priority based on urgency and impact
- Apply labels for categorization (e.g., bug, feature, tech-debt) if the workspace uses them
- `ask_operator` about priority and labels if not specified

When appropriate, use subsections under `# Outcome` to organize related items:

```
# Outcome

## Questions

- [ ] What are the key takeaways?
- [ ] Which parts apply to our strategy?

## Tasks

- [ ] Document findings
- [ ] Present to team
```

### Project Format (Linear)

**Name**: Outcome-focused description

- Good: "User authentication with SSO support"
- Good: "Get 10 customer leads for <product-name> through direct outreach"
- Bad: "Auth work"

**Description**: Goal, scope, and any constraints.

For validation or experiment projects, use the Hypothesis/Experiment/Steps pattern:

```
Hypothesis - <What you believe to be true>

Experiment
<Experiment name>

* <Step 1>
* <Step 2>
* <Step 3>
```

**Milestones**: Key checkpoints showing progression toward the goal. Examples:

- Completion states: "Target list ready", "Outreach completed", "Analysis complete"
- Phase labels: "MVP", "Full implementation", "Polish and launch"

### Initiative Format (Linear)

**Name**: Strategic objective

**Description**: Include as much information as needed to convey the business goal and how success will be measured. If unsure what to include, prompt the user for guidance.

### Project Update Format (Linear)

**Audience**: Project updates are read by non-technical stakeholders — founders, GMs, customer-facing teammates, leadership, and sometimes customers. Write for someone who cares about _what the project makes possible_, not _what work was done_.

**Style rules:**

- Lead with what is now possible, available, or unblocked because of recent progress. The reader wants to know what changed for them, not what changed in the codebase.
- Do not enumerate completed issues, PR titles, commits, or internal implementation details. "Shipped INF-204, INF-205, INF-211" is the wrong shape; "Customers can now invite teammates and assign roles without contacting support" is the right shape.
- Avoid jargon, acronyms, internal codenames, and tool-of-the-week terminology unless they are already part of the audience's vocabulary. When in doubt, spell it out in plain language.
- Frame risks and blockers by their impact on the outcome ("the launch date may slip by two weeks because we are still waiting on the vendor's API access"), not by their technical cause.
- Keep it short. A project update that takes more than a minute to read will not be read.

**Structure**:

```
## Where we are

<One or two sentences naming the current state of the project in plain terms.>

## What this unlocks

<What is now possible, available, or in motion because of recent progress. Outcome-oriented, not task-oriented.>

## What's next

<The next user-visible milestone, framed by impact rather than by the tasks required to get there.>

## Risks

<Optional. Only include if there is something the audience needs to know. Describe the impact on the outcome, not the technical cause.>
```

If a section has nothing meaningful to say in this update, omit it rather than padding it.

**Health**: Set the project health to match reality (`onTrack`, `atRisk`, `offTrack`, `complete`, or `paused`). If you would not show the chosen health to the project's sponsor with a straight face, it is the wrong health.

**Self-check before posting**: Re-read the draft and ask, "would a non-engineer who has never opened the codebase come away knowing what changed for them?" If the answer is no, rewrite it.

## Phase 5: Review and Adjust

Present the complete draft and `ask_operator` whether to adjust anything before creating:

```
I propose creating:

**Project**: Add user authentication
- Lead: <to be assigned>
- Target: <target-quarter>
- Milestones:
  1. Basic auth flow complete
  2. SSO integration complete

**Issues**:
1. "Set up authentication database schema"
2. "Implement login/logout flow"
3. "Integrate SSO provider"
4. "Add session management"
   - Blocked by: #2

Would you like to adjust anything before I create these?
```

Allow the operator to:

- Adjust titles or descriptions
- Change the structure (e.g., "make #3 and #4 one issue")
- Add or remove items
- Specify assignees or teams

## Phase 6: Create on the tracker

### Linear (`mcp__linear__*`)

Before creating artifacts, query the Linear workspace:

- **Teams**: Always query available teams (`mcp__linear__list_teams`) and `ask_operator` which team should own issues or projects
- **Projects**: Query existing projects (`mcp__linear__list_projects`) if the user mentions adding to an existing project
- **Initiatives**: Query existing initiatives (`mcp__linear__list_initiatives`) if linking to one

Present options to the user when multiple choices exist.

After user approval, create artifacts using the appropriate `mcp__linear__*` tools:

1. **Create container first** (initiative via `mcp__linear__save_initiative`, project via `mcp__linear__save_project`)
2. **Create issues** in dependency order (`mcp__linear__save_issue`)
3. **Set blocking relationships** between issues (via `mcp__linear__save_issue` parameters)
4. **Add issues to project** (via `mcp__linear__save_issue` parameters)
5. **Add projects to initiative** (via `mcp__linear__save_project` parameters)
6. **Post project updates** (via `mcp__linear__save_status_update`, targeting the project resolved during the interview)

Report created artifacts to the user with their URLs.

### GitHub (`gh`)

After approval, create each issue with `run_shell`:

```bash
gh issue create --title "<title>" --body "<body>"
```

If `gh` is missing, tell the operator to install GitHub CLI and stop. Do not invent an HTTP client. Report created issue URLs.

### GitLab (`glab`)

After approval, create each issue with `run_shell`:

```bash
glab issue create --title "<title>" --description "<body>"
```

If `glab` is missing, tell the operator to install GitLab CLI and stop. Report created issue URLs.

### Linear without MCP

Stop. Tell the operator to enable Linear MCP. Do not invent a Linear REST client.

### Other

`ask_operator` how they file issues, then follow that recipe.

## Error Handling

If creation fails:

1. Report the error to the user with any details provided by the API or CLI
2. List what was successfully created before the failure (with URLs if available)
3. Do not proceed with dependent artifacts if a parent fails (e.g., don't create issues if project creation failed)
4. Ask if they want to retry or adjust the request

## Quality Reminders

- Issues should be self-contained and handoff-ready at any moment
- A single issue should take no more than 2-3 days to implement
- Use many tickets if needed for clarity; they're cheap
- Status updates in tickets reduce interruptions

If an issue looks like it will take more than 3 days, suggest breaking it down.

## Common Patterns

### Bug Report to Issue

```
User: "The login page crashes when you enter special characters"

Issue:
  Title: Fix login page crash on special character input
  Description:
    # Background

    Login page crashes when users enter special characters in the
    username or password field.

    Steps to reproduce:
    1. Navigate to /login
    2. Enter "user@test" in username
    3. Page crashes

    # Outcome

    - [ ] Special characters in username field do not cause crash
    - [ ] Special characters in password field do not cause crash
    - [ ] Input is properly sanitized before processing
```

### Feature Request to Project and Issues

```
User: "We need to add dark mode to the application"

Project: Add dark mode theme support
  Target: 2 weeks
  Milestones:
    1. Theme infrastructure complete
    2. All components themed

Issues:
  1. "Add theme context and toggle component"
  2. "Define dark mode color palette"
  3. "Update core components for theme support"
     - Blocked by: #1, #2
  4. "Add theme persistence to user preferences"
     - Blocked by: #1
```

### Validation Project

```
User: "We need to validate if customers want our new <product-name> product"

Project: Get 10 customer leads for <product-name> through direct outreach
  Lead: <to be assigned>
  Target: 2 weeks
  Description:
    Hypothesis - Teams we know and can reach out to have a need for <product-name>.

    Experiment
    Direct Outreach

    - [ ] Create list of targets
    - [ ] Create collateral if needed
    - [ ] Create strategy for outreach including any templates
    - [ ] Execute outreach
    - [ ] Conduct customer interviews
    - [ ] Analyze results

  Milestones:
    1. Target list and collateral ready
    2. Outreach completed
    3. Customer interviews recorded
    4. Analysis complete

Issues:
  1. "Create target list for <product-name> outreach"
  2. "Create outreach collateral and templates"
  3. "Execute outreach campaign"
     - Blocked by: #1, #2
  4. "Conduct and record customer interviews"
     - Blocked by: #3
  5. "Analyze results and present findings"
     - Blocked by: #4
```

### Strategic Goal to Initiative

```
User: "We need to expand our platform to support enterprise customers"

Initiative: Enterprise platform expansion
  Owner: <executive-owner>
  Target: <target-quarter>

Projects:
  1. "Multi-tenant architecture" - Isolate customer data and resources
  2. "Enterprise SSO integration" - Support SAML and OIDC providers
  3. "Admin dashboard" - Self-service management for enterprise admins
  4. "Audit logging" - Compliance-ready activity tracking
```

### Planning Document to Issues

```
User: "Create issues from our product doc" or "--from-doc"

[Skill searches for PRODUCT.md, ARCHITECTURE.md, IMPLEMENTATION.md]
[Finds PRODUCT.md with feature descriptions]

Skill: I found PRODUCT.md which describes the following features:
  - User authentication with SSO
  - Usage metrics dashboard
  - Export functionality

Based on the document, I propose:

**Project**: User authentication with SSO support
  (From PRODUCT.md: "Users need secure login with enterprise SSO...")

**Issues**:
  1. "Implement basic email/password authentication"
     # Background
     From PRODUCT.md: Users need secure login...

     # Outcome
     - [ ] Users can register with email/password
     - [ ] Users can log in and log out

  2. "Integrate SAML SSO provider"
     ...

Which features would you like me to create issues for?
```
