import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface Quota {
  type: "session" | "weekly";
  percent_remaining: number;
  resets_at: string;
  time_remaining_seconds: number;
  time_remaining_human: string;
}

export interface CostUsage {
  spent: number;
  budget: number;
}

export interface AuthError {
  Code: string;
  Message: string;
}

export interface UsageData {
  account_type: string;
  email: string;
  quotas: Quota[] | null;
  cost_usage: CostUsage;
  captured_at: string;
  auth_error?: AuthError;
}

export type ReadResult =
  | { kind: "ok"; data: UsageData }
  | { kind: "not_authenticated"; message: string }
  | { kind: "error"; message: string };

const AUTH_ERROR_CODES = new Set([
  "setup_required",
  "not_logged_in",
  "token_expired",
  "no_subscription",
]);

export function resolveFilePath(configPath: string): string {
  if (configPath.startsWith("~")) {
    return path.join(os.homedir(), configPath.slice(1));
  }
  return configPath;
}

export async function readUsageData(filePath: string): Promise<ReadResult> {
  const resolved = resolveFilePath(filePath);

  let content: string;
  try {
    content = await fs.promises.readFile(resolved, "utf-8");
  } catch {
    return { kind: "error", message: `Cannot read file: ${resolved}` };
  }

  let data: UsageData;
  try {
    data = JSON.parse(content);
  } catch {
    return { kind: "error", message: "Invalid JSON in usage file" };
  }

  if (data.auth_error && AUTH_ERROR_CODES.has(data.auth_error.Code)) {
    return { kind: "not_authenticated", message: data.auth_error.Message };
  }

  if (!Array.isArray(data.quotas) || data.quotas.length === 0) {
    return { kind: "error", message: "No quota data available" };
  }

  return { kind: "ok", data };
}

export function formatStatusText(data: UsageData): string {
  const session = data.quotas?.find((q) => q.type === "session");
  const weekly = data.quotas?.find((q) => q.type === "weekly");

  const parts: string[] = [];

  if (session) {
    const used = 100 - session.percent_remaining;
    parts.push(`${used}% ${session.time_remaining_human}`);
  }

  if (weekly) {
    const used = 100 - weekly.percent_remaining;
    parts.push(`${used}% ${weekly.time_remaining_human}`);
  }

  return parts.join(" | ");
}
