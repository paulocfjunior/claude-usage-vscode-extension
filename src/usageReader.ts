import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
const DEBUG_MODE = true; // stores raw responses in files for debugging
const _debugOutputDir: string = process.env["CLAUDE_USAGE_DEBUG_DIR"] || os.homedir();

// ── Interfaces ──────────────────────────────────────────────

export interface Quota {
  type: "session" | "weekly" | "opus" | "sonnet";
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
  | { kind: "not_trusted"; message: string }
  | { kind: "error"; message: string };

// ── Constants ───────────────────────────────────────────────

const COMMAND_TIMEOUT_MS = 30_000;
const EARLY_KILL_DELAY_MS = 1500;

const AUTH_ERROR_CODES = new Set([
  "setup_required",
  "not_logged_in",
  "token_expired",
  "no_subscription",
]);

// ── ANSI stripping ──────────────────────────────────────────

const CURSOR_FWD_RE = /\x1B\[(\d*)C/g;
const ANSI_RE =
  /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g;

function stripAnsi(raw: string): string {
  let s = raw.replace(CURSOR_FWD_RE, (_, n) => {
    const count = Math.min(parseInt(n || "1", 10), 100);
    return " ".repeat(count);
  });
  s = s.replace(ANSI_RE, "");
  // The script PTY output uses \r (carriage return) to overwrite lines
  // instead of \n. Normalize \r to \n so each segment becomes its own line.
  s = s.replace(/\r/g, "\n");
  // Also strip BEL (\x07) and other stray control chars (except \n and \t)
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  return s;
}

// ── Text parsers ────────────────────────────────────────────

function parseAccountType(lines: string[]): string {
  for (const line of lines) {
    if (/(?:·\s*)?claude\s+max/i.test(line)) return "Claude Max";
    if (/(?:·\s*)?claude\s+pro/i.test(line)) return "Claude Pro";
    if (/(?:·\s*)?claude\s+team/i.test(line)) return "Claude Team";
    if (/(?:·\s*)?claude\s+enterprise/i.test(line)) return "Claude Enterprise";
    if (/(?:·\s*)?claude\s+api/i.test(line)) return "Claude API";
    if (/(?:·\s*)?claude\s+free/i.test(line)) return "Claude Free";
  }
  return "unknown";
}

function parseEmail(lines: string[]): string {
  for (const line of lines) {
    let m = line.match(/·\s*claude\s+(?:pro|max)\s*·\s*(\S+@\S+)/i);
    if (m) return m[1];
    m = line.match(/(?:Email|Account):\s*(\S+@\S+)/i);
    if (m) return m[1];
  }
  return "";
}

const AUTH_PATTERNS: Array<{
  pattern: RegExp;
  code: string;
  message: string;
}> = [
  {
    pattern: /let.?s\s+get\s+started/i,
    code: "setup_required",
    message:
      "Claude CLI setup required. Run 'claude' in a terminal to complete first-time setup.",
  },
  {
    pattern: /(?:token|session)\s*(?:has\s+)?expired/i,
    code: "token_expired",
    message:
      "Claude authentication token expired. Run 'claude' to re-authenticate.",
  },
  {
    pattern:
      /(?:sign\s*in|log\s*in|authenticate)\s*(?:to\s+continue|required|to\s+use)/i,
    code: "not_logged_in",
    message: "Not logged in to Claude. Run 'claude' to authenticate.",
  },
  {
    pattern: /no\s+(?:active\s+)?subscription/i,
    code: "no_subscription",
    message: "No active Claude subscription found.",
  },
  {
    pattern: /claude\.ai\/login/i,
    code: "not_logged_in",
    message: "Not logged in to Claude. Run 'claude' to authenticate.",
  },
];

function detectAuthError(lines: string[]): AuthError | undefined {
  const text = lines.join("\n");
  for (const { pattern, code, message } of AUTH_PATTERNS) {
    if (pattern.test(text)) {
      return { Code: code, Message: message };
    }
  }
  return undefined;
}

const RELATIVE_DAYS = /(\d+)\s*d(?:ays?)?/i;
const RELATIVE_HOURS = /(\d+)\s*h(?:ours?|r)?/i;
const RELATIVE_MINS = /(\d+)\s*m(?:in(?:utes?)?)?/i;

// Extracts IANA timezone from parentheses, e.g. "(America/Toronto)"
const TZ_RE = /\(([A-Za-z_/]+)\)/;
// Absolute time: "8pm", "7pm", "3pm"
const TIME_ONLY_RE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
// Date + time: "Feb 27 at 7pm", "Mar 1 at 3pm"
const DATE_TIME_RE =
  /(\w{3,9})\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;

function toHour24(hour: number, ampm: string): number {
  let h = hour;
  if (ampm.toLowerCase() === "pm" && h < 12) h += 12;
  if (ampm.toLowerCase() === "am" && h === 12) h = 0;
  return h;
}

// Get current date/time parts in a given IANA timezone
function getNowInTz(
  tz: string,
  now: number
): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(now));
  const get = (type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  return {
    year: get("year"),
    month: get("month") - 1, // 0-indexed
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

// Compute time_remaining_seconds by comparing target and current in the same timezone.
// Both are constructed via new Date(y,m,d,h,m) which uses system-local interpretation,
// but since we're only taking the DIFFERENCE, the system timezone cancels out.
function computeDiffSeconds(
  targetY: number,
  targetMo: number,
  targetD: number,
  targetH: number,
  targetMin: number,
  tz: string | undefined,
  now: number
): { time_remaining_seconds: number; resets_at: string } {
  const targetAsLocal = new Date(
    targetY, targetMo, targetD, targetH, targetMin, 0
  ).getTime();

  let nowAsLocal: number;
  if (tz) {
    const c = getNowInTz(tz, now);
    nowAsLocal = new Date(c.year, c.month, c.day, c.hour, c.minute, 0).getTime();
  } else {
    nowAsLocal = new Date(now).getTime();
    // Re-create from local parts so both use the same Date constructor
    const n = new Date(now);
    nowAsLocal = new Date(
      n.getFullYear(), n.getMonth(), n.getDate(),
      n.getHours(), n.getMinutes(), 0
    ).getTime();
  }

  let diffMs = targetAsLocal - nowAsLocal;
  const diffSeconds = Math.max(0, Math.floor(diffMs / 1000));
  const resetsAt = new Date(now + diffMs).toISOString();
  return { time_remaining_seconds: diffSeconds, resets_at: resetsAt };
}

function parseAbsoluteTime(
  line: string,
  now: number
): { resets_at: string; time_remaining_seconds: number } | undefined {
  const tzMatch = line.match(TZ_RE);
  const tz = tzMatch?.[1];

  const dateMatch = line.match(DATE_TIME_RE);
  if (dateMatch) {
    const [, monthStr, day, year, hour, min, ampm] = dateMatch;
    const y = year ? parseInt(year, 10) : new Date(now).getFullYear();
    const h = toHour24(parseInt(hour, 10), ampm);
    const m = min ? parseInt(min, 10) : 0;
    const monthIdx = new Date(`${monthStr} 1, 2000`).getMonth();
    const result = computeDiffSeconds(y, monthIdx, parseInt(day, 10), h, m, tz, now);
    if (result.time_remaining_seconds >= 0) {
      return result;
    }
  }

  const timeMatch = line.match(TIME_ONLY_RE);
  if (timeMatch) {
    const [, hour, min, ampm] = timeMatch;
    const h = toHour24(parseInt(hour, 10), ampm);
    const m = min ? parseInt(min, 10) : 0;

    // Get today's date in the target timezone
    let y: number, mo: number, d: number;
    if (tz) {
      const c = getNowInTz(tz, now);
      y = c.year;
      mo = c.month;
      d = c.day;
    } else {
      const ref = new Date(now);
      y = ref.getFullYear();
      mo = ref.getMonth();
      d = ref.getDate();
    }

    let result = computeDiffSeconds(y, mo, d, h, m, tz, now);
    if (result.time_remaining_seconds <= 0) {
      // Target is in the past — must be tomorrow
      result = computeDiffSeconds(y, mo, d + 1, h, m, tz, now);
    }
    return result;
  }

  return undefined;
}

function parseResetTime(contextLines: string[]): {
  resets_at: string;
  time_remaining_seconds: number;
  time_remaining_human: string;
} {
  const now = Date.now();

  // First pass: look for lines containing "reset"/"renew" (with possible
  // spaces injected by cursor-forward ANSI codes, e.g. "Rese ts" or "Rese s"
  // where characters in "Resets" are separated by cursor-forward spaces)
  for (const line of contextLines) {
    if (!/rese\s*t?\s*s|renew/i.test(line)) continue;

    const dMatch = line.match(RELATIVE_DAYS);
    const hMatch = line.match(RELATIVE_HOURS);
    const mMatch = line.match(RELATIVE_MINS);

    if (dMatch || hMatch || mMatch) {
      const days = dMatch ? parseInt(dMatch[1], 10) : 0;
      const hours = hMatch ? parseInt(hMatch[1], 10) : 0;
      const mins = mMatch ? parseInt(mMatch[1], 10) : 0;
      const totalSeconds = days * 86400 + hours * 3600 + mins * 60;
      const resetsAt = new Date(now + totalSeconds * 1000);
      return {
        resets_at: resetsAt.toISOString(),
        time_remaining_seconds: totalSeconds,
        time_remaining_human: formatDuration(totalSeconds),
      };
    }

    const abs = parseAbsoluteTime(line, now);
    if (abs) {
      return {
        ...abs,
        time_remaining_human: formatDuration(abs.time_remaining_seconds),
      };
    }
  }

  // Second pass: ANSI stripping may have garbled "Resets", so look for any
  // line with an absolute time pattern (am/pm) as a fallback
  for (const line of contextLines) {
    if (!/\d{1,2}\s*(?:am|pm)/i.test(line)) continue;
    // Skip lines that are the percentage line itself (e.g. "17% used")
    if (PERCENT_RE.test(line)) continue;

    const abs = parseAbsoluteTime(line, now);
    if (abs) {
      return {
        ...abs,
        time_remaining_human: formatDuration(abs.time_remaining_seconds),
      };
    }
  }

  return { resets_at: "", time_remaining_seconds: 0, time_remaining_human: "" };
}

function formatDuration(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) {
    // e.g. "4d 22h" or "1d"
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    // e.g. "3h20m" or "5h"
    return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  }
  if (mins > 0) {
    return `${mins}m`;
  }
  return "< 1m";
}

const QUOTA_LABELS: Array<{
  pattern: RegExp;
  type: Quota["type"];
}> = [
  { pattern: /current\s+session/i, type: "session" },
  { pattern: /current\s+week\s*\(all\s+models?\)/i, type: "weekly" },
  { pattern: /current\s+week\s*\(opus(?:\s+only)?\)/i, type: "opus" },
  { pattern: /current\s+week\s*\(sonnet(?:\s+only)?\)/i, type: "sonnet" },
  { pattern: /opus\s+usage/i, type: "opus" },
  { pattern: /sonnet\s+usage/i, type: "sonnet" },
];

const PERCENT_RE = /(\d{1,3})\s*%\s*(used|left)/i;

// Find the line index of the next quota section label after `startIdx`
function findNextSectionBoundary(lines: string[], startIdx: number): number {
  for (let k = startIdx + 1; k < lines.length; k++) {
    if (QUOTA_LABELS.some(({ pattern }) => pattern.test(lines[k]))) {
      return k;
    }
    // Also stop at cost/extra usage sections
    if (COST_SECTION_RE.test(lines[k])) {
      return k;
    }
  }
  return lines.length;
}

function parseQuotas(lines: string[]): Quota[] {
  const quotas: Quota[] = [];

  for (let i = 0; i < lines.length; i++) {
    const labelMatch = QUOTA_LABELS.find(({ pattern }) =>
      pattern.test(lines[i])
    );
    if (!labelMatch) continue;

    const sectionEnd = findNextSectionBoundary(lines, i);
    const searchEnd = Math.min(i + 6, sectionEnd);
    for (let j = i; j < searchEnd; j++) {
      const pMatch = lines[j].match(PERCENT_RE);
      if (!pMatch) continue;

      const value = parseInt(pMatch[1], 10);
      const isUsed = pMatch[2].toLowerCase() === "used";
      const percentRemaining = isUsed ? 100 - value : value;

      // Search the entire section for reset time (ANSI cursor codes can
      // reorder lines, so reset text may appear before or after the % line)
      const resetWindow = lines.slice(i, sectionEnd);
      const resetInfo = parseResetTime(resetWindow);

      quotas.push({
        type: labelMatch.type,
        percent_remaining: percentRemaining,
        ...resetInfo,
      });

      i = j;
      break;
    }
  }

  return quotas;
}

const COST_SECTION_RE = /extra\s+usage/i;
const COST_AMOUNT_RE = /\$?([\d,]+\.?\d*)\s*\/\s*\$?([\d,]+\.?\d*)\s*spent/i;

function parseCostUsage(lines: string[]): CostUsage {
  for (let i = 0; i < lines.length; i++) {
    if (!COST_SECTION_RE.test(lines[i])) continue;
    const searchEnd = Math.min(i + 10, lines.length);
    for (let j = i; j < searchEnd; j++) {
      const m = lines[j].match(COST_AMOUNT_RE);
      if (m) {
        return {
          spent: parseFloat(m[1].replace(",", "")),
          budget: parseFloat(m[2].replace(",", "")),
        };
      }
    }
  }
  return { spent: 0, budget: 0 };
}

// ── Trust management ────────────────────────────────────────

const CLAUDE_CONFIG_PATH = path.join(os.homedir(), ".claude.json");

interface ClaudeConfig {
  projects?: Record<
    string,
    { hasTrustDialogAccepted?: boolean; [key: string]: unknown }
  >;
  [key: string]: unknown;
}

function readClaudeConfig(): ClaudeConfig {
  try {
    const content = fs.readFileSync(CLAUDE_CONFIG_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function writeClaudeConfig(config: ClaudeConfig): void {
  fs.writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export function isWorkspaceTrusted(workspacePath: string): boolean {
  const config = readClaudeConfig();
  return config.projects?.[workspacePath]?.hasTrustDialogAccepted === true;
}

export function trustWorkspace(workspacePath: string): void {
  const config = readClaudeConfig();
  if (!config.projects) {
    config.projects = {};
  }
  if (!config.projects[workspacePath]) {
    config.projects[workspacePath] = { hasTrustDialogAccepted: true };
  } else {
    config.projects[workspacePath].hasTrustDialogAccepted = true;
  }
  writeClaudeConfig(config);
}

// ── CLI execution ───────────────────────────────────────────

function buildEnv(): NodeJS.ProcessEnv {
  const extraPaths = [
    path.join(os.homedir(), ".local", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  const currentPath = process.env["PATH"] ?? "";
  const pathParts = currentPath.split(path.delimiter);
  for (const p of extraPaths) {
    if (!pathParts.includes(p)) pathParts.unshift(p);
  }
  return {
    ...process.env,
    PATH: pathParts.join(path.delimiter),
    TERM: "xterm-256color",
  };
}

function resolveClaudeBinary(configuredPath: string): string {
  return configuredPath || "claude";
}

async function runClaudeUsage(
  claudeBinary: string,
  cwd: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    let earlyKillTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (earlyKillTimer) clearTimeout(earlyKillTimer);
      if (err) reject(err);
      else resolve(output);
    };

    const isWindows = process.platform === "win32";

    const child = isWindows
      ? cp.spawn(claudeBinary, ["/usage"], {
          stdio: ["ignore", "pipe", "pipe"],
          env: buildEnv(),
          cwd,
        })
      : cp.spawn("script", ["-q", "/dev/null", claudeBinary, "/usage"], {
          stdio: ["ignore", "pipe", "pipe"],
          env: buildEnv(),
          cwd,
        });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle(new Error("timeout"));
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
      const cleaned = stripAnsi(output);
      if (/\d{1,3}\s*%\s*(?:used|left)/i.test(cleaned) && !earlyKillTimer) {
        earlyKillTimer = setTimeout(() => {
          child.kill("SIGTERM");
          settle();
        }, EARLY_KILL_DELAY_MS);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
    });

    child.on("close", () => settle());
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        settle(new Error("ENOENT"));
      } else {
        settle(err);
      }
    });
  });
}

// ── Main entry point ────────────────────────────────────────

export async function readUsageData(
  claudePath: string,
  workspacePath: string
): Promise<ReadResult> {
  if (!isWorkspaceTrusted(workspacePath)) {
    return {
      kind: "not_trusted",
      message: `Claude CLI hasn't trusted this workspace yet. Allow the extension to authorize it?`,
    };
  }

  const binary = resolveClaudeBinary(claudePath);
  let rawOutput: string;

  try {
    rawOutput = await runClaudeUsage(binary, workspacePath);
  } catch (err) {
    const e = err as Error;
    if (e.message === "ENOENT") {
      return {
        kind: "error",
        message: `Claude CLI not found. Install from https://claude.ai/code or set claudeUsage.claudePath in settings.`,
      };
    }
    if (e.message === "timeout") {
      return {
        kind: "error",
        message: "claude /usage timed out after 30s.",
      };
    }
    return { kind: "error", message: `Failed to run claude: ${e.message}` };
  }

  return parseCliOutput(rawOutput);
}

/** Parse raw CLI output (with or without ANSI codes) into a ReadResult. Exported for testing. */
export function parseCliOutput(rawOutput: string): ReadResult {
  if (DEBUG_MODE) {
    try {
      fs.writeFileSync(path.join(_debugOutputDir, "claude-usage-debug-raw.txt"), rawOutput, "utf-8");
      const strippedDebug = stripAnsi(rawOutput);
      fs.writeFileSync(path.join(_debugOutputDir, "claude-usage-debug-stripped.txt"), strippedDebug, "utf-8");
      const debugLines = strippedDebug.split(/\r?\n/);
      const numbered = debugLines.map((l, i) => `[${i}] ${l}`).join("\n");
      fs.writeFileSync(path.join(_debugOutputDir, "claude-usage-debug-lines.txt"), numbered, "utf-8");
    } catch {
      // ignore debug write failures
    }
  }

  const stripped = stripAnsi(rawOutput);
  const lines = stripped.split(/\r?\n/);

  const authError = detectAuthError(lines);
  if (authError && AUTH_ERROR_CODES.has(authError.Code)) {
    return { kind: "not_authenticated", message: authError.Message };
  }

  const quotas = parseQuotas(lines);
  if (quotas.length === 0) {
    return {
      kind: "error",
      message: "No quota data found in claude /usage output.",
    };
  }

  const data: UsageData = {
    account_type: parseAccountType(lines),
    email: parseEmail(lines),
    quotas,
    cost_usage: parseCostUsage(lines),
    captured_at: new Date().toISOString(),
    auth_error: authError,
  };

  return { kind: "ok", data };
}

// ── Account data (from ~/.claude.json) ───────────────────────

export interface StatusInfo {
  email: string;
  displayName: string;
  billingType: string;
}

export function readStatusData(): StatusInfo | undefined {
  try {
    const filePath = path.join(os.homedir(), ".claude.json");
    const content = fs.readFileSync(filePath, "utf-8");

    if (DEBUG_MODE) {
      try {
        fs.writeFileSync(path.join(_debugOutputDir, "claude-status-debug-raw.txt"), content, "utf-8");
      } catch {
        // ignore debug write failures
      }
    }

    const data = JSON.parse(content);
    const account = data?.oauthAccount;
    if (!account) {
      return undefined;
    }

    return {
      email: account.emailAddress ?? "",
      displayName: account.displayName ?? "",
      billingType: account.billingType ?? "",
    };
  } catch {
    return undefined;
  }
}

// ── Status text formatting ──────────────────────────────────

export function formatStatusText(data: UsageData): string {
  const session = data.quotas?.find((q) => q.type === "session");
  const weekly = data.quotas?.find((q) => q.type === "weekly");
  const opus = data.quotas?.find((q) => q.type === "opus");
  const sonnet = data.quotas?.find((q) => q.type === "sonnet");

  const parts: string[] = [];

  if (session) {
    const used = 100 - session.percent_remaining;
    parts.push(`${used}% ${session.time_remaining_human}`);
  }

  if (weekly) {
    const used = 100 - weekly.percent_remaining;
    parts.push(`${used}% ${weekly.time_remaining_human}`);
  }

  if (opus) {
    const used = 100 - opus.percent_remaining;
    parts.push(`opus ${used}% ${opus.time_remaining_human}`);
  }

  if (sonnet) {
    const used = 100 - sonnet.percent_remaining;
    parts.push(`sonnet ${used}% ${sonnet.time_remaining_human}`);
  }

  return parts.join(" | ");
}
