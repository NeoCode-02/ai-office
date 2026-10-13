---
name: testing
description: Write and run tests that actually catch regressions. Use when building features, fixing bugs, or when a manager asks for proof that something works.
---

# Testing

- Use the project's existing test framework and layout. Check `package.json`, `pyproject.toml` or similar before adding anything.
- Bug fix: first write a test that fails because of the bug, then fix the code, then show it passing.
- Test behaviour through the public interface, not private details.
- Cover: the main success path, empty and invalid input, boundaries (0, 1, max), and the error path.
- Keep tests independent: no shared mutable state, no reliance on test order, no real network.
- Run the full suite with `run_command` and include the summary line (passed/failed counts) in your report. Never claim tests pass without running them.
- A flaky test is a failing test. Find the cause (time, order, randomness) instead of retrying.
