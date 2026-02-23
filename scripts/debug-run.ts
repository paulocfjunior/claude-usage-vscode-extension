#!/usr/bin/env npx tsx
/**
 * Runs the extension's core logic outside VS Code.
 * Debug files are written to ./debug-output/ in the project root.
 *
 * Usage:
 *   npm run debug
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const projectRoot = path.resolve(__dirname, "..");
const debugDir = path.join(projectRoot, "debug-output");
fs.mkdirSync(debugDir, { recursive: true });

// Set env var BEFORE requiring usageReader so it picks up the dir
process.env["CLAUDE_USAGE_DEBUG_DIR"] = debugDir;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  readUsageData,
  readStatusData,
  formatStatusText,
} = require("../src/usageReader");

function readStatsCache(): Record<string, any> | undefined {
  try {
    const filePath = path.join(os.homedir(), ".claude", "stats-cache.json");
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function buildTooltip(
  data: any,
  status: { email: string; displayName: string; billingType: string } | undefined
): string {
  const email = status?.email || data.email;
  const displayName = status?.displayName;
  const billingType = status?.billingType;

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
    lines.push(`${q.type}: ${used}% used, resets in ${q.time_remaining_human}`);
  }
  if (data.cost_usage && (data.cost_usage.spent > 0 || data.cost_usage.budget > 0)) {
    lines.push(
      "",
      `Cost: $${data.cost_usage.spent.toFixed(2)} / $${data.cost_usage.budget.toFixed(2)}`
    );
  }

  const stats = readStatsCache();
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

async function main() {
  const cwd = process.cwd();

  console.log("=== Claude Usage Debug Run ===");
  console.log(`CWD: ${cwd}`);
  console.log(`Debug output: ${debugDir}`);
  console.log();

  // 1. Account info from ~/.claude.json
  console.log("--- Account Info (from ~/.claude.json) ---");
  const status = readStatusData();
  if (status) {
    console.log(`  Email:   ${status.email}`);
    console.log(`  Name:    ${status.displayName}`);
    console.log(`  Billing: ${status.billingType}`);
  } else {
    console.log("  (not available)");
  }
  console.log();

  // 2. Usage data from claude /usage
  console.log("--- Usage Data (running claude /usage) ---");
  const result = await readUsageData("", cwd);

  switch (result.kind) {
    case "ok": {
      const text = formatStatusText(result.data);
      console.log(`  Status bar: ${text}`);
      console.log(`  Account:    ${result.data.account_type} (${result.data.email})`);
      console.log(`  Captured:   ${result.data.captured_at}`);
      if (result.data.quotas) {
        for (const q of result.data.quotas) {
          const used = 100 - q.percent_remaining;
          console.log(`  ${q.type}: ${used}% used, resets in ${q.time_remaining_human}`);
        }
      }
      if (result.data.cost_usage) {
        console.log(`  Cost: $${result.data.cost_usage.spent.toFixed(2)} / $${result.data.cost_usage.budget.toFixed(2)}`);
      }
      break;
    }
    case "not_trusted":
      console.log(`  Not trusted: ${result.message}`);
      break;
    case "not_authenticated":
      console.log(`  Not authenticated: ${result.message}`);
      break;
    case "error":
      console.log(`  Error: ${result.message}`);
      break;
  }

  console.log();
  console.log("Debug files:");
  const debugFiles = fs.readdirSync(debugDir);
  for (const f of debugFiles) {
    const stat = fs.statSync(path.join(debugDir, f));
    console.log(`  ${f} (${stat.size} bytes)`);
  }

  // Exact extension output
  if (result.kind === "ok") {
    const statusBarText = `☁ ${formatStatusText(result.data)}`;
    const tooltip = buildTooltip(result.data, status);
    console.log();
    console.log("=== Extension Output ===");
    console.log();
    console.log(`Status bar: ${statusBarText}`);
    console.log();
    console.log("Tooltip:");
    console.log(tooltip);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
