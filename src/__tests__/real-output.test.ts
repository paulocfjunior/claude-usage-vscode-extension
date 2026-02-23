import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseCliOutput } from "../usageReader";

// Freeze "now" to Feb 22 2026, 5:00pm America/Toronto (UTC-5 = 10:00pm UTC)
const FAKE_NOW = new Date("2026-02-22T22:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers({ now: FAKE_NOW });
});

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf-8");
}

describe("parseCliOutput — real raw output from script PTY", () => {
  let result: ReturnType<typeof parseCliOutput>;

  beforeEach(() => {
    const raw = loadFixture("claude-usage-real-raw.txt");
    result = parseCliOutput(raw);
  });

  it("returns ok", () => {
    expect(result.kind).toBe("ok");
  });

  it("parses 3 quotas", () => {
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.data.quotas).toHaveLength(3);
  });

  it("parses session quota — 25% used", () => {
    if (result.kind !== "ok") throw new Error("expected ok");
    const session = result.data.quotas!.find((q) => q.type === "session");
    expect(session).toBeDefined();
    expect(session!.percent_remaining).toBe(75);
  });

  it("parses session reset time — resets 8pm (3h remaining)", () => {
    if (result.kind !== "ok") throw new Error("expected ok");
    const session = result.data.quotas!.find((q) => q.type === "session");
    expect(session).toBeDefined();
    // 8pm Toronto - 5pm Toronto = 3h = 10800s
    expect(session!.time_remaining_seconds).toBe(10800);
    expect(session!.time_remaining_human).toBe("3h");
  });

  it("parses weekly quota — 8% used, resets Feb 27 at 7pm", () => {
    if (result.kind !== "ok") throw new Error("expected ok");
    const weekly = result.data.quotas!.find((q) => q.type === "weekly");
    expect(weekly).toBeDefined();
    expect(weekly!.percent_remaining).toBe(92);
    // Feb 27 7pm - Feb 22 5pm = 5d 2h = 5*86400 + 2*3600 = 439200
    expect(weekly!.time_remaining_seconds).toBe(439200);
    expect(weekly!.time_remaining_human).toBe("5d 2h");
  });

  it("parses sonnet quota — 0% used, resets Mar 1 at 3pm", () => {
    if (result.kind !== "ok") throw new Error("expected ok");
    const sonnet = result.data.quotas!.find((q) => q.type === "sonnet");
    expect(sonnet).toBeDefined();
    expect(sonnet!.percent_remaining).toBe(100);
    // Mar 1 3pm - Feb 22 5pm = 6d 22h = 6*86400 + 22*3600 = 597600
    expect(sonnet!.time_remaining_seconds).toBe(597600);
    expect(sonnet!.time_remaining_human).toBe("6d 22h");
  });
});
