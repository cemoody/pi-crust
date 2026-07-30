/**
 * TDD characterization tests for the server-side coercers being moved into
 * src/shared/util.ts. Written before the move; each test pins down exactly
 * one branch of the source functions (numberOrNull, coerceTimestamp,
 * sumNumbers) so the consolidation can't drift.
 *
 * Source functions, pre-move:
 *   - numberOrNull        — src/server/pi/pirpc-pi-adapter.ts:1275
 *   - dateLikeToTime      — src/server/pi/pirpc-pi-adapter.ts:1279
 *   - coerceTimestamp     — src/server/pi/sdk-pi-adapter.ts:357
 *   - coerceTime          — src/server/http-api-server.ts:1268
 *   - sumNumbers          — src/server/pi/pirpc-pi-adapter.ts:1292
 *
 * coerceTimestamp(): all four near-twin date coercers fold into one helper
 * with `number | undefined` (the most common pre-existing return type;
 * callers using `?? null` / `?? 0` keep working unchanged).
 */
import { describe, expect, it } from "vitest";
import { coerceTimestamp, errorMessage, isRecord, numberOrNull, sumNumbers, uniqueBy, uniqueValues } from "../../src/shared/util.js";

describe("isRecord", () => {
  it("accepts objects but excludes null, arrays, and primitives", () => {
    expect(isRecord({ key: "value" })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("text")).toBe(false);
    expect(isRecord(42)).toBe(false);
  });
});

describe("uniqueValues", () => {
  it("keeps the first occurrence of each value in insertion order", () => {
    expect(uniqueValues(["alpha", "beta", "alpha", "gamma", "beta"])).toEqual(["alpha", "beta", "gamma"]);
  });

  it("uses Set equality for primitive edge cases", () => {
    expect(uniqueValues([Number.NaN, Number.NaN, 0, -0])).toEqual([Number.NaN, 0]);
  });

  it("does not mutate the input array", () => {
    const values = ["one", "one", "two"];
    expect(uniqueValues(values)).toEqual(["one", "two"]);
    expect(values).toEqual(["one", "one", "two"]);
  });
});

describe("uniqueBy", () => {
  it("keeps the first value for each key in insertion order", () => {
    const values = [
      { id: "alpha", value: 1 },
      { id: "beta", value: 2 },
      { id: "alpha", value: 3 },
    ];

    expect(uniqueBy(values, (value) => value.id)).toEqual([
      { id: "alpha", value: 1 },
      { id: "beta", value: 2 },
    ]);
  });

  it("does not mutate the input array", () => {
    const values = [{ id: "one" }, { id: "one" }, { id: "two" }];
    expect(uniqueBy(values, (value) => value.id)).toEqual([{ id: "one" }, { id: "two" }]);
    expect(values).toEqual([{ id: "one" }, { id: "one" }, { id: "two" }]);
  });
});

describe("errorMessage", () => {
  it("prefers an Error message", () => {
    expect(errorMessage(new Error("request failed"))).toBe("request failed");
  });

  it("uses a plain object's message for cross-realm error shapes", () => {
    expect(errorMessage({ message: "worker failed", code: "EWORKER" })).toBe("worker failed");
  });

  it("serializes message-less objects instead of returning [object Object]", () => {
    expect(errorMessage({ code: "EWORKER", retryable: false })).toBe('{"code":"EWORKER","retryable":false}');
  });

  it("handles circular thrown objects without throwing", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(errorMessage(circular)).toBe("[unserializable error]");
  });
});

describe("coerceTimestamp", () => {
  it("passes a finite number through", () => {
    expect(coerceTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(coerceTimestamp(0)).toBe(0);
  });

  it("parses an ISO date string", () => {
    expect(coerceTimestamp("2024-01-01T00:00:00.000Z")).toBe(Date.parse("2024-01-01T00:00:00.000Z"));
  });

  it("returns the .getTime() of a Date instance", () => {
    const d = new Date(1_234_567_890);
    expect(coerceTimestamp(d)).toBe(1_234_567_890);
  });

  it("returns undefined for non-finite numbers (NaN, Infinity)", () => {
    expect(coerceTimestamp(Number.NaN)).toBeUndefined();
    expect(coerceTimestamp(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("returns undefined for unparseable strings", () => {
    expect(coerceTimestamp("not a date")).toBeUndefined();
    expect(coerceTimestamp("")).toBeUndefined();
    expect(coerceTimestamp("   ")).toBeUndefined();
  });

  it("returns undefined for undefined/null/boolean/object", () => {
    expect(coerceTimestamp(undefined)).toBeUndefined();
    expect(coerceTimestamp(null)).toBeUndefined();
    expect(coerceTimestamp(true)).toBeUndefined();
    expect(coerceTimestamp({ when: 1 })).toBeUndefined();
  });
});

describe("numberOrNull", () => {
  it("returns finite numbers", () => {
    expect(numberOrNull(42)).toBe(42);
    expect(numberOrNull(-1.5)).toBe(-1.5);
    expect(numberOrNull(0)).toBe(0);
  });

  it("returns null for NaN, Infinity, and non-numbers", () => {
    expect(numberOrNull(Number.NaN)).toBeNull();
    expect(numberOrNull(Number.POSITIVE_INFINITY)).toBeNull();
    expect(numberOrNull(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(numberOrNull("42")).toBeNull();
    expect(numberOrNull(undefined)).toBeNull();
    expect(numberOrNull(null)).toBeNull();
    expect(numberOrNull({})).toBeNull();
  });
});

describe("sumNumbers", () => {
  it("sums the listed keys, treating missing keys as 0", () => {
    expect(sumNumbers({ a: 1, b: 2, c: 3 }, ["a", "b"])).toBe(3);
    expect(sumNumbers({ a: 1 }, ["a", "missing"])).toBe(1);
  });

  it("coerces string-numbers via Number(...)", () => {
    expect(sumNumbers({ a: "5", b: 2 }, ["a", "b"])).toBe(7);
  });

  it("returns 0 for an undefined record", () => {
    expect(sumNumbers(undefined, ["a", "b"])).toBe(0);
  });

  it("returns 0 when no keys are listed", () => {
    expect(sumNumbers({ a: 1 }, [])).toBe(0);
  });
});
