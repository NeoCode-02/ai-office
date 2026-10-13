---
name: security-review
description: Find real, exploitable security problems in a codebase and report them with severity and fixes. Use for security audits, pentest-style reviews, or before shipping.
---

# Security review

Only report what you can trace from an untrusted source to a dangerous sink. No speculative findings.

1. Map the attack surface: HTTP routes, CLI args, file uploads, webhooks, env/config, third-party input.
2. Trace each input to sinks:
   - SQL/NoSQL queries built with string concatenation
   - Shell commands, `eval`, template rendering, deserialization
   - File paths (traversal), outbound URLs (SSRF), HTML output (XSS)
3. Check access control on every route that reads or changes data: who may call it, and is ownership checked (IDOR)?
4. Check secrets: hard-coded keys, tokens in logs, `.env` committed, weak hashing (use bcrypt/argon2 for passwords).
5. Check dependencies for known-vulnerable versions with the ecosystem's audit command.

Report each finding as:
- **Title** — severity (critical / high / medium / low)
- Where: file:line
- Exploit: concrete steps or request that triggers it
- Fix: the smallest correct change

Test only the project in the shared workspace. Never attack external systems.
