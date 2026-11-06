import "@calcom/testing/lib/__mocks__/prisma";
import prisma from "@calcom/prisma";
import { describe, expect, it } from "vitest";

describe("Prisma mock date defaults", () => {
  it("returns dates for generated defaults and preserves explicit dates", async () => {
    const before = Date.now();
    const user = await prisma.user.create({
      data: { email: "default@example.com", username: "default" },
    });
    const supplied = new Date("2020-04-02T15:04:05.678Z");
    const datedUser = await prisma.user.create({
      data: { email: "dated@example.com", username: "dated", createdDate: supplied },
    });

    expect(user.createdDate).toBeInstanceOf(Date);
    expect(user.createdDate.getTime()).toBeGreaterThanOrEqual(before);
    expect(user.createdDate.getTime()).toBeLessThanOrEqual(Date.now());
    expect(datedUser.createdDate).toEqual(supplied);
  });
});
