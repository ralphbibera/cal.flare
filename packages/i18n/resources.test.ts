import { describe, expect, it } from "vitest";
import { loadDictionary } from "./resources";

describe("loadDictionary", () => {
  it("loads a bundled locale", async () => {
    const dictionary = await loadDictionary("fr");

    expect(dictionary).toHaveProperty("welcome", "Bienvenue");
  });

  it("returns an empty dictionary for an unknown locale", async () => {
    expect(await loadDictionary("not-a-locale")).toEqual({});
  });

  it.each([
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
  ])("returns an empty dictionary for the inherited object key %s", async (locale) => {
    expect(await loadDictionary(locale)).toEqual({});
  });
});
