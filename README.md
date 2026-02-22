# Claude Usage Status Bar Widget

A VS Code extension that displays your Claude API usage quota directly in the status bar.

![Status Bar Example](https://img.shields.io/badge/status%20bar-☁%208%25%203h%2030m%20%7C%201%25%206d%2022h-blue)

## How it looks

```
☁ 8% 3h 30m | 1% 6d 22h
```

Format: `[session_used%] [session_time_remaining] | [weekly_used%] [weekly_time_remaining]`

Hover over the status bar item for detailed account info, per-quota breakdown, and cost data.

## Prerequisites

This extension reads usage data from [claude-o-meter](https://github.com/MartinLoeper/claude-o-meter). You need it running in daemon mode:

```bash
# Install claude-o-meter (Go required)
go install github.com/MartinLoeper/claude-o-meter@latest

# Start the daemon (writes JSON every 60s)
claude-o-meter daemon -i 60s -f ~/.cache/claude-o-meter.json
```

You must have the [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated with an active Pro or Max subscription.

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
| `claudeUsage.filePath` | `~/.cache/claude-o-meter.json` | Path to the claude-o-meter JSON file |
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

## License

MIT
