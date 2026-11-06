import { describe, expect, it } from "vitest";
import { parseBookingScheduledJobs } from "./scheduledJobs";

describe("booking scheduled jobs", () => {
  it("preserves exact job identifiers, order, duplicates and selected fields", () => {
    const scheduledJobs = ["", "  ", "job/1?b=2&a=1", "é", ""];
    const startTime = new Date();
    const booking = parseBookingScheduledJobs({ id: 23, startTime, scheduledJobs });
    expect(booking).toEqual({ id: 23, startTime, scheduledJobs });
    expect(booking.startTime).toBe(startTime);
  });

  it.each([null, []])("projects empty storage %j to an empty list", (scheduledJobs) => {
    expect(parseBookingScheduledJobs({ scheduledJobs }).scheduledJobs).toEqual([]);
  });

  it.each([
    undefined,
    {},
    "[]",
    [null],
    [["job"]],
    [1],
    [true],
  ])("rejects malformed jobs %j", (scheduledJobs) => {
    expect(() => parseBookingScheduledJobs({ scheduledJobs })).toThrow();
  });
});
