import { describe, expect, it } from "vitest";
import { parseDisabledHolidayIds } from "./parseDisabledHolidayIds";

describe("disabled holiday ids", () => {
  it("preserves empty lists and maps SQL null to an empty list", () => {
    expect(parseDisabledHolidayIds([])).toEqual([]);
    expect(parseDisabledHolidayIds(null)).toEqual([]);
  });

  it("preserves identifiers, order and duplicates without sharing mutable storage", () => {
    const stored = ["christmas_2026", "春節", "christmas_2026", ""];
    const result = parseDisabledHolidayIds(stored);
    expect(result).toEqual(stored);
    result.push("new-year_2027");
    expect(stored).toEqual(["christmas_2026", "春節", "christmas_2026", ""]);
  });

  it.each([
    undefined,
    "[]",
    {},
    { set: ["holiday"] },
    [null],
    [1],
    [["holiday"]],
  ])("rejects invalid persisted list %j", (value) => {
    expect(() => parseDisabledHolidayIds(value)).toThrow();
  });
});
