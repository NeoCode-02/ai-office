# Changelog

## 0.3.0

### Costs and limits
- Exact token accounting: Anthropic cache reads and writes, cached input of OpenAI-compatible APIs (DeepSeek, Kimi, OpenRouter), hidden reasoning tokens (Gemini), OpenRouter's billed cost. A model without a price shows as *unknown*, never $0.
- Billing per provider: pay per token (prices per model, built in for Claude, or filled from OpenRouter's public catalog on exact matches), subscription (fee and plan limit) or free.
- **Usage** page: spend per day, model and member; provider balances (DeepSeek, Kimi, OpenRouter key limit); plan-limit meters.
- Rate limits and outages are retried (honouring `retry-after`); out of credit, a rejected key or a missing model moves the member to its **backup model** with a log of its work, or stops it with a card (retry / use another model).
- Daily and monthly spending caps for the whole app; a request limit and a loop guard per office; the budget blocks new messages once spent.

### Working with a team
- Plan mode, "always allow" for commands, MCP tools and local hosts, compaction of long conversations, per-member effort, reply limit and skills.
- Changes and undo: every task starts from a snapshot (a separate repository); diffs, undo per file or all, commit to your own repository.
- Tool output and diffs in the feed, live replies, history search and Markdown export, office export/import.
- Optional Docker sandbox for `run_command`.
- Notifications, attention badge, theme setting, update check, single instance.

### Security
- File tools: symlinks resolved everywhere, no writes inside `.git`, FIFOs and devices refused, no file tool while a command runs in the same workspace.
- `web_fetch`: pinned DNS, link-local/metadata never fetched, this computer (including its public addresses) and the local network only with approval, redirects re-checked, 2 MB cap, linear-time HTML to text.
- `run_command`: input closed, the process tree is ended on stop and timeout; the Docker sandbox mounts `.git` read-only.
- Search runs in a worker with a timeout (no regex can freeze the app).
- IPC: only the app's own window, every argument shape-checked. Electron fuses: no `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` or inspector; asar integrity; cookie encryption.
- Imported offices never bring permissions or MCP access.

## 0.2.0
- Graphite + amber redesign, English and Uzbek, MCP servers, skills, Claude Code-style plugins, CI and installers.
