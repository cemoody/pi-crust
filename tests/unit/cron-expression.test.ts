import { describe, expect, it } from "vitest";
import { parseCron, matches, nextRun, CronParseError } from "../../src/server/cron/cron-expression.js";

describe("parseCron", () => {
  it("parses all-star expression", () => {
    const p = parseCron("* * * * *");
    expect(p.minute.size).toBe(60);
    expect(p.hour.size).toBe(24);
    expect(p.dom.size).toBe(31);
    expect(p.month.size).toBe(12);
    expect(p.dow.size).toBe(7);
    expect(p.domStar).toBe(true);
    expect(p.dowStar).toBe(true);
  });

  it("expands */N steps", () => {
    const p = parseCron("*/15 * * * *");
    expect([...p.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it("expands ranges and lists", () => {
    const p = parseCron("0 9-11 * * 1,3,5");
    expect([...p.hour].sort((a, b) => a - b)).toEqual([9, 10, 11]);
    expect([...p.dow].sort((a, b) => a - b)).toEqual([1, 3, 5]);
  });

  it("expands ranged steps like 0-30/10", () => {
    const p = parseCron("0-30/10 * * * *");
    expect([...p.minute].sort((a, b) => a - b)).toEqual([0, 10, 20, 30]);
  });

  it("treats N/step as N..max step (Vixie cron behavior)", () => {
    const p = parseCron("5/15 * * * *");
    expect([...p.minute].sort((a, b) => a - b)).toEqual([5, 20, 35, 50]);
  });

  it("rejects expressions with wrong field count", () => {
    expect(() => parseCron("* * * *")).toThrow(CronParseError);
    expect(() => parseCron("* * * * * *")).toThrow(CronParseError);
  });

  it("rejects empty input", () => {
    expect(() => parseCron("   ")).toThrow(CronParseError);
  });

  it("rejects out-of-range values", () => {
    expect(() => parseCron("60 * * * *")).toThrow(CronParseError);
    expect(() => parseCron("* 24 * * *")).toThrow(CronParseError);
    expect(() => parseCron("* * 0 * *")).toThrow(CronParseError);
    expect(() => parseCron("* * * 13 *")).toThrow(CronParseError);
    expect(() => parseCron("* * * * 7")).toThrow(CronParseError);
  });

  it("rejects non-numeric values", () => {
    expect(() => parseCron("a * * * *")).toThrow(CronParseError);
  });

  it("rejects empty comma-separated list entries", () => {
    expect(() => parseCron("1, * * * *")).toThrow(CronParseError);
    expect(() => parseCron(", * * * *")).toThrow(CronParseError);
    expect(() => parseCron("1,2, * * * *")).toThrow(CronParseError);
    expect(() => parseCron("* * * * 1,")).toThrow(CronParseError);
  });

  it("rejects zero or negative steps", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow(CronParseError);
  });
});

describe("matches", () => {
  it("matches on minute boundary", () => {
    const p = parseCron("*/15 * * * *");
    expect(matches(p, new Date(2024, 0, 1, 10, 0))).toBe(true);
    expect(matches(p, new Date(2024, 0, 1, 10, 15))).toBe(true);
    expect(matches(p, new Date(2024, 0, 1, 10, 7))).toBe(false);
  });

  it("requires hour, dom, month, dow to all match (when dom and dow are stars)", () => {
    const p = parseCron("0 9 * * *");
    expect(matches(p, new Date(2024, 5, 12, 9, 0))).toBe(true);
    expect(matches(p, new Date(2024, 5, 12, 10, 0))).toBe(false);
  });

  it("uses OR semantics when both dom and dow are restricted", () => {
    // Run on the 1st OR on Mondays at 09:00.
    const p = parseCron("0 9 1 * 1");
    // June 1, 2024 was a Saturday → dom matches, dow does not. OR → true.
    expect(matches(p, new Date(2024, 5, 1, 9, 0))).toBe(true);
    // June 3, 2024 was a Monday → dow matches, dom does not. OR → true.
    expect(matches(p, new Date(2024, 5, 3, 9, 0))).toBe(true);
    // June 4, 2024 was a Tuesday → neither matches.
    expect(matches(p, new Date(2024, 5, 4, 9, 0))).toBe(false);
  });

  it("uses AND semantics when at least one of dom/dow is a star", () => {
    const p = parseCron("0 9 1 * *");
    // June 1 matches.
    expect(matches(p, new Date(2024, 5, 1, 9, 0))).toBe(true);
    // June 2 (Sun) does not.
    expect(matches(p, new Date(2024, 5, 2, 9, 0))).toBe(false);
  });
});

describe("nextRun", () => {
  it("finds the next minute boundary", () => {
    const p = parseCron("*/15 * * * *");
    const from = new Date(2024, 0, 1, 10, 7, 30);
    const next = nextRun(p, from);
    expect(next).toBeDefined();
    expect(next!.getTime()).toBe(new Date(2024, 0, 1, 10, 15, 0, 0).getTime());
  });

  it("skips current minute when called exactly on it (strict future)", () => {
    const p = parseCron("0 9 * * *");
    const from = new Date(2024, 5, 12, 9, 0, 0, 0);
    const next = nextRun(p, from);
    expect(next!.getTime()).toBe(new Date(2024, 5, 13, 9, 0, 0, 0).getTime());
  });

  it("crosses month boundary correctly", () => {
    const p = parseCron("0 0 1 * *");
    const from = new Date(2024, 0, 5, 10, 0, 0, 0);
    const next = nextRun(p, from);
    expect(next!.getTime()).toBe(new Date(2024, 1, 1, 0, 0, 0, 0).getTime());
  });
});
