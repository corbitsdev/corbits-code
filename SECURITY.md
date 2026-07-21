# Security Policy

## Reporting a Vulnerability

Please report security issues through [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository (Security tab → Report a vulnerability).

Do not open a public issue for security reports.

We will acknowledge reports as soon as practical and work with you on a fix and disclosure timeline.

## Scope Notes

Intercode is a coding agent that **executes shell commands and file operations on the host** under an authorization policy. Treat any unexpected command execution, path escape, or permission-bypass behavior as security-relevant.

When reporting, include:

- Intercode version or commit
- Steps to reproduce
- Expected vs actual behavior
- Whether the issue requires a malicious prompt, config, skill, MCP server, or tool grant
