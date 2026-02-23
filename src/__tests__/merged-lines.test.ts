import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseCliOutput } from "../usageReader";

const FAKE_NOW = new Date("2026-02-22T21:40:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers({ now: FAKE_NOW });
});

function loadFixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf-8");
}

describe("parseCliOutput — merged lines (ANSI artifact simulation)", () => {
  it("still parses session reset time when % and reset are on the same line", () => {
    const raw = loadFixture("claude-usage-merged-lines.txt");
    const result = parseCliOutput(raw);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    const session = result.data.quotas!.find((q) => q.type === "session");
    expect(session).toBeDefined();
    expect(session!.percent_remaining).toBe(86);
    // Must show ~3h20m, NOT 5d 2h
    expect(session!.time_remaining_seconds).toBe(12000);
    expect(session!.time_remaining_human).toBe("3h20m");
  });

  it("still parses weekly reset time on merged line", () => {
    const raw = loadFixture("claude-usage-merged-lines.txt");
    const result = parseCliOutput(raw);
    if (result.kind !== "ok") return;

    const weekly = result.data.quotas!.find((q) => q.type === "weekly");
    expect(weekly).toBeDefined();
    expect(weekly!.time_remaining_seconds).toBe(440400);
    expect(weekly!.time_remaining_human).toBe("5d 2h");
  });

  it("still parses sonnet reset time on merged line", () => {
    const raw = loadFixture("claude-usage-merged-lines.txt");
    const result = parseCliOutput(raw);
    if (result.kind !== "ok") return;

    const sonnet = result.data.quotas!.find((q) => q.type === "sonnet");
    expect(sonnet).toBeDefined();
    expect(sonnet!.time_remaining_seconds).toBe(598800);
    expect(sonnet!.time_remaining_human).toBe("6d 22h");
  });
});
