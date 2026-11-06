import { AppCategories } from "@calcom/prisma/enums";
import { describe, expect, it } from "vitest";
import { parseAppCategories } from "./parseAppCategories";

describe("stored app categories", () => {
  it("preserves enum order, duplicates and other selected fields", () => {
    const createdAt = new Date("2026-11-05T00:00:00Z");
    const app = { slug: "test", categories: ["video", "calendar", "video"], createdAt };
    const result = parseAppCategories(app);
    expect(result).toEqual({ slug: "test", categories: ["video", "calendar", "video"], createdAt });
    expect(result.createdAt).toBe(createdAt);
    expect(app.categories).toEqual(["video", "calendar", "video"]);
  });

  it("maps SQL null and empty arrays to logical empty arrays", () => {
    expect(parseAppCategories({ categories: null }).categories).toEqual([]);
    expect(parseAppCategories({ categories: [] }).categories).toEqual([]);
  });

  it("accepts every canonical app category", () => {
    const categories = Object.values(AppCategories);
    expect(parseAppCategories({ categories }).categories).toEqual(categories);
  });

  it.each([
    undefined,
    "calendar",
    [null],
    [["calendar"]],
    [1],
    ["CALENDAR"],
    ["unknown"],
    {},
  ])("rejects malformed stored categories %j", (categories) => {
    expect(() => parseAppCategories({ categories })).toThrow();
  });
});
