# Contributing

Thanks for helping. Small, focused pull requests are the easiest to review.

## Setup

```bash
npm install
npm run dev
```

## Before you open a pull request

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run e2e   # the built app against a fake provider (needs the Electron binary)
```

CI runs the checks on Linux, Windows and macOS, and the end-to-end run on Linux and Windows.

## Guidelines

- **One change per pull request.** A bug fix and a refactor are two pull requests.
- **Keep dependencies out.** Prefer the standard library, the platform, or a few lines of our own code. Open an issue before adding a package.
- **Test the logic you add.** Orchestration, tools, MCP and extension code live in `src/main` and are tested with Vitest; see `src/main/*.test.ts` for the style (fake providers, temp folders, no network).
- **UI text goes through `src/renderer/src/i18n.ts`.** Add the English string and the Uzbek one; TypeScript fails if a key is missing.
- **Prompts and tool results sent to models are in English.** The models answer in the language of the user's goal.
- **Security-sensitive changes** (file paths, commands, secrets, IPC) need a test that shows the boundary holds.

## Adding a provider

Most providers speak the OpenAI API. Add a preset to `PRESETS` in `src/main/providers.ts` with its base URL and the page where users get a key. Only write a new adapter if the provider cannot be reached through the OpenAI-compatible one.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org): `feat(ui): …`, `fix(main): …`, `docs: …`.
