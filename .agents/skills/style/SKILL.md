---
name: style
description: General coding conventions for clean, maintainable code. Always load this skill when writing or reviewing code in any language.
---

# Style

General guidelines for writing clean, maintainable code.

## Git Repository Requirement

Agents must only operate within git repositories. Before performing any work:

1. Verify the current working directory is inside a git repository
2. If not in a git repository, refuse to proceed

Without a git repository, it's too hard to succeed with agents - changes can't be tracked, reviewed, or safely reverted.

## Documentation

### Avoiding Redundant Comments

Code should be self-documenting. Do not add comments that describe what the code obviously does:

```
// Bad - obvious comments
// Base configuration type for all backends
BaseConfigArgs = { level: LogLevel }

// Good - let code speak for itself
BaseConfigArgs = { level: LogLevel }
```

Decorative comment blocks (ASCII art dividers, section headers) add visual noise without providing meaningful information.

**When comments ARE useful:**

- Complex algorithms that aren't immediately obvious
- Non-obvious workarounds or edge cases
- TODO/FIXME/XXX markers for future work
- Business logic that requires explanation

```
// XXX - Temporary workaround until upstream fix
// TODO - Switch to newMethod when minimum version is bumped
result = await legacyMethod()
```

## Git Workflow

### Commit Messages

Commits should read like a story, allowing others and future-you to understand why changes were made.

**Commit Organization:**

- Separate refactoring from feature additions (distinct commits)
- Separate formatting/whitespace fixes from logical changes
- Each commit should represent one logical unit of work
- **Amend** (`git commit --amend`) to refine the most recent commit (e.g., critique fixes, wording changes, missed files)
- **Fixup** (`git commit --fixup=<sha>` + `git rebase --autosquash`) to fix an earlier unpushed commit when a later review reveals a problem that belongs on that commit, not HEAD

**Message Format:**

- **Summary line**: Max 72 characters, non-empty
- **Blank line**: Required between summary and body (if body exists)
- **Body lines**: Max 72 characters each

Some projects use a "Conventional Commits" prefix format (e.g. `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`). Do not use this style. Summary lines should be plain English sentences with no abbreviations, no prefixes, and should not end with punctuation.

**Good examples:**

```
Add retry logic for failed network requests

Fix race condition in transaction verification

Document API response format
```

**Bad examples:**

```
feat: add retry logic
Update code (too vague)
Fix bug in server.ts (includes filename)
```

## Naming

### Acronyms

Acronyms are not words. Do not reshape them to fit camelCase or PascalCase word boundaries. Preserve the acronym's natural capitalization regardless of position in the name.

```
// Good
JSONSchema, HTTPClient, parseJSON, requestURL

// Bad - treating acronyms as regular words
JsonSchema, HttpClient, parseJson, requestUrl
```

## Documentation Maintenance

When making changes to code, check whether related documentation needs updating:

- README files that reference changed functionality
- API documentation for modified interfaces
- Inline comments that describe changed behavior
- Configuration examples that no longer apply

Update documentation in the same commit as the code change, not as a separate task.

## Scope Discipline

Only touch code that is directly related to the task at hand. Do not make drive-by changes to surrounding code, even if they look like improvements. Common violations:

- Reformatting lines you didn't otherwise need to change
- Adding or removing comments on unrelated code
- Renaming variables or functions outside the scope of your task
- Adjusting whitespace, import order, or style in files you're passing through
- "While I'm here" refactors that aren't part of the assignment

These changes pollute diffs, make review harder, and risk introducing unintended breakage. If you notice something that genuinely needs fixing, raise it as a separate piece of work rather than bundling it in.

## Code Reuse and Refactoring

Do not reimplement functionality that already exists in the codebase. Before writing new code:

1. Search for existing implementations that could serve the same purpose
2. If similar functionality exists, prefer refactoring it to meet the new requirements
3. Look for unexported functions in other packages that could be promoted to a shared location

When a refactor might be necessary, prompt the user with specific options:

- Refactor the existing implementation
- Promote an unexported function to a shared package
- Create a new implementation

Allow the user to provide their own answer if none of the options fit.

## Removing Dead Code

When refactoring replaces an old implementation, delete the old one. Do not leave backwards-compatibility shims, re-exports, renamed `_unused` variables, or `// removed` comments for code that no longer serves a purpose. If all callers are internal and have been updated, the old path should not survive. See the `philosophy` skill for the reasoning behind this.

## External Code Attribution

Any code from outside the organization requires careful attribution and licensing compliance:

1. **License verification**: Check that the license is compatible with your project
2. **Isolated commit**: Place external code in its own commit without any modifications
3. **Complete attribution**: Include in the commit message:
   - Original source URL or reference
   - Author/copyright information
   - License type
   - Date retrieved
   - Any other details required for audit compliance

If modifications to external code are needed, make them in a separate follow-up commit with clear explanation of what changed and why.

## Data Validation

Never trust data from outside the program. All external input -- user submissions, API responses, file contents, environment variables, query parameters, message payloads -- must be validated at the boundary where it enters the system. Parse it, check it, and reject it if it's wrong. Once data has crossed the boundary and been validated, internal code can trust it without re-checking.

This means validation logic lives at the edge: HTTP handlers, CLI argument parsers, message consumers, file readers, and configuration loaders. It does not live deep inside business logic, scattered across internal functions, or deferred until the data happens to cause a failure somewhere downstream.

If invalid data can travel through multiple layers before something finally breaks, the validation boundary is in the wrong place.

## Build Verification

Always run the full build command before declaring any task complete.

- Individual package builds do not guarantee the full tree will build
- Do not work around a failing build by running individual targets and treating their success as equivalent
- If the build fails, report the failure to the user and identify the cause
- If the failure is pre-existing and unrelated to your changes, say so explicitly and let the user decide how to proceed

Never silently skip a failing step or substitute a partial build.

## Configuration Files

Do not modify configuration files (e.g. eslint, prettier, tsconfig) unless explicitly asked. Focus on writing working software, not changing the conventions that are being used.

Keep consistent even if we disagree; if we decide to change a style, make it an explicit decision and discussion, not a side effect of other work.

## Personality

Do not use emojis in code or documentation. Act professionally.

## Acknowledgment

At the start of a session, after reviewing this skill, state: "I have reviewed the style skill, and I am ready to proceed in good taste."
