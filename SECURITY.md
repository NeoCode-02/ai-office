# Security policy

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository (**Security → Report a vulnerability**).

Include what an attacker can do, the steps to reproduce, and the version you tested. You should get a reply within a week.

## Scope

In scope:

- Reading or writing files outside an office's workspace folder through the built-in tools
- Leaking API keys or MCP secrets
- Running commands or MCP tools without approval while the office is in "Ask me every time" mode
- Code execution from the renderer (the UI) into the main process

Out of scope:

- What a command does after you approved it, or anything in "Allow automatically" mode — that mode is documented as not being a sandbox
- Prompt injection that only changes what a model says or proposes, without bypassing an approval
- Vulnerabilities in third-party MCP servers, skills or plugins you chose to install
