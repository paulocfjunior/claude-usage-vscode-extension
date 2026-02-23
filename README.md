# Claude Usage Status Bar Widget

A VS Code extension that displays your Claude API usage quota directly in the status bar.

![Status Bar Example](https://img.shields.io/badge/status%20bar-☁%208%25%203h%2030m%20%7C%201%25%206d%2022h-blue)

## How it looks

```
☁ 8% 3h 30m | 1% 6d 22h | opus 5% 6d 22h
```

Format: `[session_used%] [session_time] | [weekly_used%] [weekly_time] | [model_used%] [model_time]`

Hover over the status bar item for detailed account info, per-quota breakdown, and cost data.

## Prerequisites

- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- An active Pro or Max subscription

The extension runs `claude /usage` directly — no external tools or daemons needed.

## Installation

### From `.vsix` file

```bash
code --install-extension claude-usage-status-bar-0.0.1.vsix
```

### From source

```bash
git clone https://github.com/paulocfjunior/claude-usage-vscode-extension.git
cd claude-usage-vscode-extension
npm install
npm run package
code --install-extension claude-usage-status-bar-0.0.1.vsix
```

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeUsage.claudePath` | `""` (auto-discover) | Path to the Claude CLI binary. Leave empty to find from PATH. |
| `claudeUsage.updateIntervalSeconds` | `60` | How often to refresh usage data (minimum 10s) |

## Commands

- **Claude Usage: Refresh Now** — Force refresh the status bar data (also triggered by clicking the widget)

## Status indicators

| Icon | Meaning |
|---|---|
| `☁` | Data loaded successfully |
| `⟳` (spinning) | Refreshing data |
| `⚠` | Error reading usage data |
| `🔑` | Claude CLI not authenticated |
| `🛡` | Workspace not yet trusted — click to authorize |

## License

MIT
