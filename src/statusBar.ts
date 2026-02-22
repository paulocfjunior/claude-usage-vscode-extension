import * as vscode from "vscode";
import { readUsageData, formatStatusText, UsageData } from "./usageReader";
import { getFilePath, getUpdateIntervalMs } from "./config";

const REFRESH_THROTTLE_MS = 5000;

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastManualRefresh = 0;
  private lastDisplayText = "";

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.name = "Claude Usage";
    this.statusBarItem.command = "claudeUsage.refresh";
    this.statusBarItem.tooltip = "Claude API Usage (click to refresh)";
    this.statusBarItem.show();
  }

  public activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(this.statusBarItem);

    context.subscriptions.push(
      vscode.commands.registerCommand("claudeUsage.refresh", () =>
        this.manualRefresh()
      )
    );

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("claudeUsage")) {
          this.restartTimer();
          this.refresh();
        }
      })
    );

    this.refresh();
    this.startTimer();
  }

  public dispose(): void {
    this.stopTimer();
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => this.refresh(), getUpdateIntervalMs());
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private restartTimer(): void {
    this.startTimer();
  }

  private manualRefresh(): void {
    const now = Date.now();
    if (now - this.lastManualRefresh < REFRESH_THROTTLE_MS) {
      return;
    }
    this.lastManualRefresh = now;
    this.refresh();
  }

  private async refresh(): Promise<void> {
    // Show loading indicator while keeping last data visible
    if (this.lastDisplayText) {
      this.statusBarItem.text = `$(sync~spin) ${this.lastDisplayText}`;
    } else {
      this.statusBarItem.text = "$(sync~spin) Claude: loading...";
    }

    const result = await readUsageData(getFilePath());

    switch (result.kind) {
      case "ok": {
        const text = formatStatusText(result.data);
        this.lastDisplayText = text;
        this.statusBarItem.text = `$(cloud) ${text}`;
        this.statusBarItem.backgroundColor = undefined;
        this.statusBarItem.tooltip = this.buildTooltip(result.data);
        break;
      }
      case "not_authenticated":
        this.lastDisplayText = "";
        this.statusBarItem.text = "$(key) Claude not authenticated";
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground"
        );
        this.statusBarItem.tooltip = `Claude: ${result.message}\n\nClick to retry`;
        break;
      case "error":
        this.lastDisplayText = "";
        this.statusBarItem.text = "$(warning) Claude Usage Error";
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground"
        );
        this.statusBarItem.tooltip = `Claude Usage: ${result.message}\n\nClick to retry`;
        break;
    }
  }

  private buildTooltip(data: UsageData): string {
    const lines = [
      `Account: ${data.account_type} (${data.email})`,
      `Updated: ${new Date(data.captured_at).toLocaleTimeString()}`,
      "",
    ];
    for (const q of data.quotas ?? []) {
      const used = 100 - q.percent_remaining;
      lines.push(
        `${q.type}: ${used}% used, resets in ${q.time_remaining_human}`
      );
    }
    if (data.cost_usage) {
      lines.push(
        "",
        `Cost: $${data.cost_usage.spent.toFixed(2)} / $${data.cost_usage.budget.toFixed(2)}`
      );
    }
    lines.push("", "Click to refresh");
    return lines.join("\n");
  }
}
