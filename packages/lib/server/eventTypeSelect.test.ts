import { describe, expect, it } from "vitest";
import { parseInstantMeetingParameters } from "./eventTypeSelect";

describe("instant meeting parameters", () => {
  it("preserves exact strings, ordering, duplicates and selected fields", () => {
    const instantMeetingParameters = ["", "https://EXAMPLE.com/path?b=2&a=1", "  ", "é", ""];
    const createdAt = new Date();
    const eventType = parseInstantMeetingParameters({ id: 17, createdAt, instantMeetingParameters });
    expect(eventType).toEqual({ id: 17, createdAt, instantMeetingParameters });
    expect(eventType.createdAt).toBe(createdAt);
  });

  it.each([null, []])("projects empty storage %j to an empty list", (instantMeetingParameters) => {
    expect(parseInstantMeetingParameters({ instantMeetingParameters }).instantMeetingParameters).toEqual([]);
  });

  it.each([
    undefined,
    {},
    "[]",
    [null],
    [["value"]],
    [1],
    [true],
  ])("rejects malformed parameters %j", (instantMeetingParameters) => {
    expect(() => parseInstantMeetingParameters({ instantMeetingParameters })).toThrow();
  });
});
