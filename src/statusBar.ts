import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  readUsageData,
  readStatusData,
  formatStatusText,
  trustWorkspace,
  UsageData,
  StatusInfo,
  ReadResult,
} from "./usageReader";
import { getClaudePath, getUpdateIntervalMs } from "./config";

const REFRESH_THROTTLE_MS = 5000;

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastManualRefresh = 0;
  private lastDisplayText = "";
  private lastResult: ReadResult | undefined;
  private cachedStatus: StatusInfo | undefined;

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
        this.onClick()
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

  private getWorkspacePath(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].uri.fsPath;
    }
    return process.cwd();
  }

  private async onClick(): Promise<void> {
    if (this.lastResult && this.lastResult.kind !== "ok") {
      await this.showErrorDetails(this.lastResult);
      return;
    }

    const now = Date.now();
    if (now - this.lastManualRefresh < REFRESH_THROTTLE_MS) {
      return;
    }
    this.lastManualRefresh = now;
    this.refresh();
  }

  private async showErrorDetails(result: ReadResult): Promise<void> {
    if (result.kind === "ok") {
      return;
    }

    if (result.kind === "not_trusted") {
      const action = await vscode.window.showWarningMessage(
        result.message,
        "Allow",
        "Cancel"
      );
      if (action === "Allow") {
        trustWorkspace(this.getWorkspacePath());
        this.refresh();
      }
    } else if (result.kind === "not_authenticated") {
      const action = await vscode.window.showWarningMessage(
        `Claude not authenticated: ${result.message}`,
        "Retry",
        "Open Settings"
      );
      if (action === "Retry") {
        this.refresh();
      } else if (action === "Open Settings") {
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "claudeUsage"
        );
      }
    } else {
      const action = await vscode.window.showErrorMessage(
        `Claude Usage: ${result.message}`,
        "Retry",
        "Open Settings"
      );
      if (action === "Retry") {
        this.refresh();
      } else if (action === "Open Settings") {
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "claudeUsage"
        );
      }
    }
  }

  private async refresh(): Promise<void> {
    if (this.lastDisplayText) {
      this.statusBarItem.text = `$(sync~spin) ${this.lastDisplayText}`;
    } else {
      this.statusBarItem.text = "$(sync~spin) Claude: loading...";
    }

    const workspacePath = this.getWorkspacePath();
    const claudePath = getClaudePath();
    const result = await readUsageData(claudePath, workspacePath);
    this.lastResult = result;
    this.cachedStatus = readStatusData();

    switch (result.kind) {
      case "ok": {
        const text = formatStatusText(result.data);
        this.lastDisplayText = text;
        this.statusBarItem.text = `$(cloud) ${text}`;
        this.statusBarItem.backgroundColor = undefined;
        this.statusBarItem.tooltip = this.buildTooltip(result.data);
        break;
      }
      case "not_trusted":
        this.lastDisplayText = "";
        this.statusBarItem.text = "$(shield) Claude: workspace not trusted";
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground"
        );
        this.statusBarItem.tooltip = `${result.message}\n\nClick to authorize`;
        break;
      case "not_authenticated":
        this.lastDisplayText = "";
        this.statusBarItem.text = "$(key) Claude not authenticated";
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground"
        );
        this.statusBarItem.tooltip = `${result.message}\n\nClick for details`;
        break;
      case "error":
        this.lastDisplayText = "";
        this.statusBarItem.text = "$(warning) Claude Usage Error";
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.warningBackground"
        );
        this.statusBarItem.tooltip = `${result.message}\n\nClick for details`;
        break;
    }
  }

  private buildTooltip(data: UsageData): string {
    const email = this.cachedStatus?.email || data.email;
    const displayName = this.cachedStatus?.displayName;
    const billingType = this.cachedStatus?.billingType;

    const lines = [
      `Account: ${data.account_type} (${email})`,
    ];
    if (displayName) {
      lines.push(`Name: ${displayName}`);
    }
    if (billingType) {
      lines.push(`Billing: ${billingType.replace(/_/g, " ")}`);
    }
    lines.push(
      `Updated: ${new Date(data.captured_at).toLocaleTimeString()}`,
      "",
    );
    for (const q of data.quotas ?? []) {
      const used = 100 - q.percent_remaining;
      lines.push(
        `${q.type}: ${used}% used, resets in ${q.time_remaining_human}`
      );
    }
    if (data.cost_usage && (data.cost_usage.spent > 0 || data.cost_usage.budget > 0)) {
      lines.push(
        "",
        `Cost: $${data.cost_usage.spent.toFixed(2)} / $${data.cost_usage.budget.toFixed(2)}`
      );
    }

    const stats = this.readStatsCache();
    if (stats) {
      lines.push("", "--- Stats ---");

      if (stats.totalSessions != null || stats.totalMessages != null) {
        const parts: string[] = [];
        if (stats.totalSessions != null) {
          parts.push(`${stats.totalSessions} sessions`);
        }
        if (stats.totalMessages != null) {
          parts.push(`${stats.totalMessages.toLocaleString()} messages`);
        }
        lines.push(`Total: ${parts.join(", ")}`);
      }

      if (stats.firstSessionDate) {
        const d = new Date(stats.firstSessionDate);
        if (!isNaN(d.getTime())) {
          lines.push(`Since: ${d.toLocaleDateString()}`);
        }
      }

      const today = new Date().toISOString().slice(0, 10);
      const todayActivity = stats.dailyActivity?.find(
        (a: { date: string }) => a.date === today
      );
      if (todayActivity) {
        const parts: string[] = [];
        if (todayActivity.messageCount) {
          parts.push(`${todayActivity.messageCount} msgs`);
        }
        if (todayActivity.sessionCount) {
          parts.push(`${todayActivity.sessionCount} sessions`);
        }
        if (todayActivity.toolCallCount) {
          parts.push(`${todayActivity.toolCallCount} tool calls`);
        }
        if (parts.length > 0) {
          lines.push(`Today: ${parts.join(", ")}`);
        }
      }
    }

    lines.push("", "Click to refresh");
    return lines.join("\n");
  }

  private readStatsCache(): Record<string, any> | undefined {
    try {
      const filePath = path.join(os.homedir(), ".claude", "stats-cache.json");
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    } catch {
      return undefined;
    }
  }
}
