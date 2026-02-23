import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseCliOutput, formatStatusText } from "../usageReader";

// Freeze "now" to Feb 22 2026, 4:40pm America/Toronto (UTC-5 = 9:40pm UTC)
// This lets us assert exact remaining-time values against the fixture.
const FAKE_NOW = new Date("2026-02-22T21:40:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers({ now: FAKE_NOW });
});

function loadFixture(name: string): string {
  return fs.readFileSync(
    path.join(__dirname, "fixtures", name),
    "utf-8"
  );
}

// ─── Fixture: Claude Team account ───────────────────────────

describe("parseCliOutput — team fixture", () => {
  let result: ReturnType<typeof parseCliOutput>;

  beforeEach(() => {
    const raw = loadFixture("claude-usage-team.txt");
    result = parseCliOutput(raw);
  });

  it("returns ok", () => {
    expect(result.kind).toBe("ok");
  });

  it("parses 3 quotas", () => {
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.data.quotas).toHaveLength(3);
  });

  it("parses session quota — 14% used, resets at 8pm today", () => {
    if (result.kind !== "ok") throw new Error("expected ok");
    const session = result.data.quotas!.find((q) => q.type === "session");
    expect(session).toBeDefined();
    expect(session!.percent_remaining).toBe(86);
    // 8pm Toronto = 4:40pm now → 3h20m = 12000s
    expect(session!.time_remaining_seconds).toBe(12000);
    expect(session!.time_remaining_human).toBe("3h20m");
  });

  it("parses weekly quota — 7% used, resets Feb 27 at 7pm", () => {
    if (result.kind !== "ok") throw new Error("expected ok");
    const weekly = result.data.quotas!.find((q) => q.type === "weekly");
    expect(weekly).toBeDefined();
    expect(weekly!.percent_remaining).toBe(93);
    // Feb 27 7pm Toronto - Feb 22 4:40pm Toronto = 4d 26h20m = 4*86400 + 2*3600 + 20*60
    // = 345600 + 7200 + 1200 = 354000 + 1200... let me compute:
    // Feb 22 4:40pm → Feb 27 7pm = 5 days 2h20m = 5*86400 + 2*3600 + 20*60
    // = 432000 + 7200 + 1200 = 440400
    expect(weekly!.time_remaining_seconds).toBe(440400);
    expect(weekly!.time_remaining_human).toBe("5d 2h");
  });

  it("parses sonnet quota — 0% used, resets Mar 1 at 3pm", () => {
    if (result.kind !== "ok") throw new Error("expected ok");
    const sonnet = result.data.quotas!.find((q) => q.type === "sonnet");
    expect(sonnet).toBeDefined();
    expect(sonnet!.percent_remaining).toBe(100);
    // Mar 1 3pm Toronto - Feb 22 4:40pm Toronto = 6d 22h20m = 6*86400 + 22*3600 + 20*60
    // = 518400 + 79200 + 1200 = 598800
    expect(sonnet!.time_remaining_seconds).toBe(598800);
    expect(sonnet!.time_remaining_human).toBe("6d 22h");
  });

  it("detects account type", () => {
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.data.account_type).toBe("Claude Team");
  });
});

// ─── formatStatusText ───────────────────────────────────────

describe("formatStatusText", () => {
  it("formats session + weekly + sonnet", () => {
    const text = formatStatusText({
      account_type: "unknown",
      email: "",
      captured_at: "",
      cost_usage: { spent: 0, budget: 0 },
      quotas: [
        {
          type: "session",
          percent_remaining: 86,
          resets_at: "",
          time_remaining_seconds: 12000,
          time_remaining_human: "3h20m",
        },
        {
          type: "weekly",
          percent_remaining: 93,
          resets_at: "",
          time_remaining_seconds: 440400,
          time_remaining_human: "5d 2h",
        },
        {
          type: "sonnet",
          percent_remaining: 100,
          resets_at: "",
          time_remaining_seconds: 598800,
          time_remaining_human: "6d 22h",
        },
      ],
    });
    expect(text).toBe("14% 3h20m | 7% 5d 2h | sonnet 0% 6d 22h");
  });
});

// ─── Edge cases ─────────────────────────────────────────────

describe("parseCliOutput — auth errors", () => {
  it("detects setup required", () => {
    const result = parseCliOutput("Let's get started! Choose a theme...");
    expect(result.kind).toBe("not_authenticated");
  });

  it("detects token expired", () => {
    const result = parseCliOutput("Your session has expired. Please log in again.");
    expect(result.kind).toBe("not_authenticated");
  });

  it("detects no subscription", () => {
    const result = parseCliOutput("No active subscription found for this account.");
    expect(result.kind).toBe("not_authenticated");
  });
});

describe("parseCliOutput — no data", () => {
  it("returns error for empty output", () => {
    const result = parseCliOutput("");
    expect(result.kind).toBe("error");
  });

  it("returns error for garbage output", () => {
    const result = parseCliOutput("some random text\nwith no usage data\n");
    expect(result.kind).toBe("error");
  });
});

// ─── Minimal clean input (no ANSI) ─────────────────────────

describe("parseCliOutput — clean text", () => {
  it("parses a minimal clean fixture", () => {
    const input = [
      "· Claude Pro · user@example.com",
      "",
      "Current session",
      "14% used",
      "Resets 8pm (America/Toronto)",
      "",
      "Current week (all models)",
      "7% used",
      "Resets Feb 27 at 7pm (America/Toronto)",
    ].join("\n");

    const result = parseCliOutput(input);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    expect(result.data.account_type).toBe("Claude Pro");
    expect(result.data.email).toBe("user@example.com");
    expect(result.data.quotas).toHaveLength(2);

    const session = result.data.quotas![0];
    expect(session.type).toBe("session");
    expect(session.percent_remaining).toBe(86);
    expect(session.time_remaining_seconds).toBe(12000);
    expect(session.time_remaining_human).toBe("3h20m");

    const weekly = result.data.quotas![1];
    expect(weekly.type).toBe("weekly");
    expect(weekly.percent_remaining).toBe(93);
  });
});
