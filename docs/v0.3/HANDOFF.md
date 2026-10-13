# v0.3 handoff — what is done, what is left

Read `docs/v0.3/SPEC.md` first (the full plan; section names W1–W5, U1–U3, D1–D2 are used below).
Branch: `claude/sleepy-noether-f3h8jq`. Checks on the current head: `npx tsc --noEmit -p tsconfig.json`, `npx eslint .`, `npm test` (377 tests), `npx electron-vite build` — all pass.

## Done and merged
- Contract: `src/shared/api.ts` (every IPC handler), new types in `src/shared/types.ts`, preload bridge, i18n areas (`src/renderer/src/i18n/{run,org,shell}.ts`), new error codes.
- W1 tools & security: symlink-safe `inside()`, no symlink following in walks, `.git` write block, read_file size/binary guard, search in a worker with timeout (ReDoS), exec kills the process group / stdin closed / Docker sandbox (`dockerArgs`), web_fetch with pinned DNS + private/link-local address rules + manual redirects + size cap, unified diffs.
- W2 providers: abort signal, OpenAI `finish_reason: length` orphans, effort / maxTokens, live text for Anthropic, more built-in Claude prices, aborted errors never retried.
- W3 infra: settings, stale-run reconcile, deleteRun, no folder resurrection after delete, atomic extensions save, capUse, shadow-git checkpoints + commitWorkspace, update check, export/import + run Markdown, IPC validators (`validate.ts`).
- W4 orchestrator: abort on stop, request cap (counts from the owner's latest message), chatter/loop guard, budget E_BUDGET_SPENT + `configure()`, shared stop/report cleanup, MCP clip, compaction, plan mode (enforced in code), allow list (`isAllowed`/`allowRule`), tool detail/diff, live deltas, per-member effort/maxTokens/skills, sandbox.
- U1 Work view, U2 Team & office settings, U3 App shell (all items of their spec sections).

## Left to do (in this order)

### 1. W5 — wire the main process (REQUIRED: until this is done the new UI features fail with E_NOT_IMPLEMENTED)
File: `src/main/index.ts` (+ `src/main/mcp.ts` clientInfo version). Every stub `todo()` in `handlers` must be implemented. Follow SPEC W5 items 1–15 exactly. Key points:
- `start` → `checkpoints.snapshot` (when `project.checkpoints !== false`) then start; snapshot errors become one system message, never block.
- Office deps: `stream` → `CHANNELS.delta` (throttle 50 ms/agent, always send final value and null), `allow` → append to project.allowCommands and save.
- `answer(projectId, id, ok, always)`, `answerPlan`, `saveProject` → `office.configure(p)` when running.
- Caps (store/stats `capUse`), notifications + badge, single-instance lock, IPC sender check + `validate.ts` on every handler, `reconcileRuns()` at startup, theme via `nativeTheme.themeSource`, update check at startup, export/import dialogs, `deleteProvider` force, `openWorkspace`, stop all offices on `before-quit`.
- Add tests where logic is pure (e.g. the allow-list persistence helper, delta throttle).

### 2. Review findings to fix (verified by reviewers, not yet fixed)
Security (W1, major):
- `src/main/fetch.ts`: treat the machine's own interface addresses (`os.networkInterfaces()`, incl. global IPv6) as loopback → needs approval.
- `src/main/fetch.ts`/`tools.ts` `htmlToText`: quadratic on unclosed `<script`/`<svg`/`<` → make it linear (indexOf scan, `[^<>]*`).
- `src/main/exec.ts` Docker: mount `<root>/.git` read-only (`-v <root>/.git:/workspace/.git:ro`) so sandboxed commands can't plant hooks; pass `-e HOME=/tmp` with `--user`.
- `src/main/tools.ts`: check-then-open race on symlinks (TOCTOU). Minimum: don't run file tools while a run_command is running in the same workspace (per-workspace lock); open with `O_NOFOLLOW` where possible.
- `write_file` to an existing non-regular file (FIFO) blocks the main process → refuse non-regular targets, open with `O_NONBLOCK|O_NOFOLLOW`.
- exec: process-group kill misses `setsid` children and Windows leftovers → fix the run_command description (don't promise more than it does).
W2 (minor): network drops surface as `terminated`/`UND_ERR_SOCKET` in the error cause → add to NETWORK and check `err.cause`; with a mid-stream server-side fallback, ignore blocks before the last `fallback` block and price by the model that served (`msg.model`).
U2 (minor): "role defaults" button also resets tools (rename or only reset instructions); keep the raw role title the user typed; drag data should use a private MIME type (`application/x-ai-office-member`); export hint wording vs allowCommands (W3 import drops them — say "not imported"); `Work.tsx` ModelInput should pass `hasKey`.
U3 (minor): Prefs caps lose typed values on a failed save; `parseUsd("1,000")` = 1 → reject thousands separators; Extensions load error stuck on "Loading…" (show error + retry); ConfirmButton needs an aria-label; notification click for a deleted office.
Not reviewed at all: W3, W4, U1 — review them (`git log` shows their commits) before release.

### 3. D1 — E2E + packaging
- Playwright `_electron` (`@playwright/test` 1.59.1 as devDependency) with a fake OpenAI-compatible server (`GET /v1/models`, `POST /v1/chat/completions` scripted by the agent name in the system prompt "You are <Name>,"). Flow: add Custom provider → new office (type the folder path) → goal → approve a command → final report → Changes panel lists the written file → Undo all removes it. Run under `xvfb-run` on Linux; the Electron binary must be downloaded (CI check job sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1` — use a separate e2e job without it).
- `package.json`: version `0.3.0`; `build.electronLanguages` → `["en-US", "uz"]` (no Russian UI exists); `build.electronFuses`: `runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true, enableCookieEncryption: true` (we use no `process.fork`).
- CI: add `macos-latest` to the check matrix; add the e2e job.
- Not possible without the owner: code signing (needs certificates), pinning Actions to SHAs (verify the SHAs first).

### 4. D2 — docs
README.md + README.uz.md: new features (plan mode, limits/loop guard, compaction, changes & undo, allow list, Docker sandbox, caps, notifications, theme, export/import, update check) and accurate security text (symlinks now handled; web_fetch rules; Docker is opt-in and MCP servers are not sandboxed). SECURITY.md scope: add local-network web_fetch and `.git` writes. New CHANGELOG.md for 0.3.0. Update screenshots later.

### 5. Final
Run the app once (`npm run dev` or the E2E) and click through: provider, office, task with approval, plan mode, changes/undo, history export, settings, theme. Then open a PR from this branch.
