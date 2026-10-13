---
name: code-review
description: Review a code change for bugs, security issues and maintainability before accepting it. Use when a manager checks a report's deliverable or before reporting your own code as done.
---

# Code review

1. Read the task's acceptance criteria first. A review checks the work against them, not against taste.
2. Open every changed file. Do not review from the author's summary alone.
3. Run it: build, tests, and the main path by hand (`run_command`). Paste the real output into your feedback.
4. Look for, in this order:
   - Correctness: wrong logic, unhandled errors, off-by-one, empty/null input, race conditions.
   - Security: untrusted input reaching SQL, shell, file paths or HTML; secrets in code; missing auth checks.
   - Data loss: writes without validation, deletes without confirmation, migrations without a way back.
   - Tests: is the risky logic covered? Would the test fail if the code broke?
   - Simplicity: dead code, duplication, abstractions with one user.
5. Write feedback as a list. Each item: file and line, what is wrong, why it matters, a concrete fix. Mark each **blocking** or **nit**.
6. Accept only when every blocking item is fixed and you have re-run the checks yourself.
