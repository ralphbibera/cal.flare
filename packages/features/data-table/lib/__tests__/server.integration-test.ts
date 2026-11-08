import { prisma } from "@calcom/prisma";
import { setupMiniflareD1 } from "@calcom/testing/lib/d1/setupMiniflareD1";
import { describe, expect } from "vitest";

import { makeWhereClause } from "../server";
import { ColumnFilterType } from "../types";
import type { TextFilterValue } from "../types";

const d1 = setupMiniflareD1({
  worker: async () => (await import("../../../../../apps/web/cloudflare.config")).default.worker,
});

const textFilter = (operator: TextFilterValue["data"]["operator"], operand: string): TextFilterValue => ({
  type: ColumnFilterType.TEXT,
  data: { operator, operand },
});

describe("makeWhereClause text filters on D1", () => {
  d1.beforeAll(async () => {
    await d1.db.batch(
      [
        [1, "Alice"],
        [2, "ALICE cooper"],
        [3, "alicia"],
        [4, "Bob"],
        [5, "Team Alpha"],
        [6, "ALPHA"],
        [7, null],
      ].map(([id, name]) =>
        d1.db
          .prepare('INSERT INTO "users" ("id", "uuid", "email", "name") VALUES (?, ?, ?, ?)')
          .bind(id, `filter-user-${id}`, `filter${id}@example.invalid`, name)
      )
    );
  }, 30_000);

  const namesMatching = (operator: TextFilterValue["data"]["operator"], operand: string) =>
    d1.run(async () => {
      const users = await prisma.user.findMany({
        where: makeWhereClause({ columnName: "name", filterValue: textFilter(operator, operand) }),
        select: { name: true },
        orderBy: { id: "asc" },
      });
      return users.map((user) => user.name);
    });

  d1.it("folds ASCII case for contains, startsWith and endsWith like PostgreSQL ILIKE", async () => {
    expect(await namesMatching("contains", "alice")).toEqual(["Alice", "ALICE cooper"]);
    expect(await namesMatching("startsWith", "ALI")).toEqual(["Alice", "ALICE cooper", "alicia"]);
    expect(await namesMatching("endsWith", "COOPER")).toEqual(["ALICE cooper"]);
    expect(await namesMatching("contains", "team")).toEqual(["Team Alpha"]);
  });

  d1.it("negates a case-insensitive contains and still drops NULL names", async () => {
    expect(await namesMatching("notContains", "alice")).toEqual(["alicia", "Bob", "Team Alpha", "ALPHA"]);
    expect(await namesMatching("notContains", "TEAM")).toEqual([
      "Alice",
      "ALICE cooper",
      "alicia",
      "Bob",
      "ALPHA",
    ]);
  });

  d1.it("keeps equals and notEquals case-sensitive as PostgreSQL did", async () => {
    expect(await namesMatching("equals", "alice")).toEqual([]);
    expect(await namesMatching("equals", "Alice")).toEqual(["Alice"]);
    expect(await namesMatching("notEquals", "Alice")).toEqual([
      "ALICE cooper",
      "alicia",
      "Bob",
      "Team Alpha",
      "ALPHA",
    ]);
  });

  d1.it("keeps empty-string filters unchanged", async () => {
    expect(await namesMatching("isEmpty", "")).toEqual([]);
    expect(await namesMatching("isNotEmpty", "")).toEqual([
      "Alice",
      "ALICE cooper",
      "alicia",
      "Bob",
      "Team Alpha",
      "ALPHA",
    ]);
  });
});
