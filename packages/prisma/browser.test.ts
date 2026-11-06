import { objectEnumValues } from "@prisma/client/runtime/index-browser";
import { describe, expect, it } from "vitest";

describe("generated Prisma browser namespace", () => {
  it("exports canonical JSON null sentinels without server capabilities", async () => {
    const browser = await import("./generated/prisma/browser");
    const { Prisma } = browser;
    for (const name of ["DbNull", "JsonNull", "AnyNull"] as const) {
      expect(Prisma[name]).toBe(objectEnumValues.instances[name]);
      expect(Prisma[name].toString()).toBe(`Prisma.${name}`);
    }
    expect(Prisma.NullableJsonNullValueInput).toEqual({
      DbNull: Prisma.DbNull,
      JsonNull: Prisma.JsonNull,
    });
    expect(Prisma.JsonNullValueInput.JsonNull).toBe(Prisma.JsonNull);
    expect(Prisma.JsonNullValueFilter).toEqual({
      DbNull: Prisma.DbNull,
      JsonNull: Prisma.JsonNull,
      AnyNull: Prisma.AnyNull,
    });
    expect(Prisma.DbNull).not.toBe(Prisma.JsonNull);
    expect(Prisma.AnyNull).not.toBe(Prisma.DbNull);
    expect(browser).not.toHaveProperty("PrismaClient");
    expect(Prisma).not.toHaveProperty("PrismaClientKnownRequestError");
    expect(Prisma).not.toHaveProperty("sql");
  });
});

describe("generated Prisma server namespace", () => {
  it("retains the client, error classes and query helpers", async () => {
    const { Prisma, PrismaClient } = await import("./client");
    const runtime = await import("@prisma/client/runtime/wasm-compiler-edge");
    expect(PrismaClient).toBeTypeOf("function");
    expect(Prisma.PrismaClientKnownRequestError).toBe(runtime.PrismaClientKnownRequestError);
    expect(Prisma.sql).toBe(runtime.sqltag);
    for (const name of ["DbNull", "JsonNull", "AnyNull"] as const) {
      expect(Prisma[name]).toBe(runtime.objectEnumValues.instances[name]);
    }
  });
});
