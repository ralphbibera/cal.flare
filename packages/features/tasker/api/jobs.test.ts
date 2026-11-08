import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { handler } from "./jobs";

describe("jobs handler", () => {
  it("rejects a public dispatch", async () => {
    const response = await handler(
      new NextRequest("https://cal.test/api/tasks/jobs", {
        method: "POST",
        body: JSON.stringify({ jobs: [] }),
      })
    );

    expect(response.status).toBe(401);
  });
});
