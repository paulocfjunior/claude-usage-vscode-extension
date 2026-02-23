# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VS Code extension that displays Claude API usage quota in the status bar. It spawns `claude /usage` as a child process via PTY (`script` wrapper on macOS/Linux), parses the ANSI-laden output, and renders a compact status bar item like `☁ 8% 3h 30m | 1% 6d 22h | opus 5% 6d 22h`.

## Commands

- `npm run compile` — TypeScript compile to `out/`
- `npm run watch` — incremental compile for development
- `npm test` — run all tests with vitest (`vitest run`)
- `npx vitest run src/__tests__/usageReader.test.ts` — run a single test file
- `npm run package` — bundle as `.vsix` via vsce
- Press F5 in VS Code to launch the Extension Development Host (uses `.vscode/launch.json`)

No linter configured; TypeScript strict mode is the primary static analysis.

## Architecture

```
extension.ts  →  StatusBarManager (statusBar.ts)  →  readUsageData (usageReader.ts)
                                                   →  config.ts (VS Code settings)
```

- **extension.ts** — Entry point (`activate`/`deactivate`). Creates `StatusBarManager`.
- **statusBar.ts** — `StatusBarManager` orchestrates the polling timer, status bar UI updates, click handling, and error display.
- **usageReader.ts** — Core logic: spawns CLI, strips ANSI codes, parses quota data. Exports `parseCliOutput` (pure, testable) and `formatStatusText`. Uses a `ReadResult` discriminated union with kinds: `ok`, `not_authenticated`, `not_trusted`, `error`.
- **config.ts** — Reads VS Code settings (`claudeUsage.claudePath`, `claudeUsage.updateIntervalSeconds`).

### Trust Model

Before running the CLI, the extension checks `~/.claude.json` for `projects[workspacePath].hasTrustDialogAccepted === true`. If untrusted, it shows a warning with an Allow button that writes the trust entry.

### ANSI Parsing

The CLI output comes through a PTY and contains ANSI escape codes, cursor-forward sequences, and sometimes merged/reordered lines. The parser handles these edge cases — see the test fixtures in `src/__tests__/fixtures/` for real-world examples.

### Recognized Quota Types

`session`, `weekly`, `opus`, `sonnet` — each with percentage and reset time (relative like `3d 2h` or absolute with IANA timezone).

## Testing

Tests are in `src/__tests__/` using vitest. Fixtures in `src/__tests__/fixtures/` contain real captured CLI output (raw ANSI and stripped). Tests cover the parser against clean input, real PTY output, merged-line edge cases, and reordered output.
