import { WebhookTriggerEvents } from "@calcom/prisma/enums";
import { describe, expect, it } from "vitest";
import { parseWebhookEventTriggers } from "./eventTriggers";

describe("webhook event triggers", () => {
  it("preserves every enum value, order, duplicates and other selected fields", () => {
    const eventTriggers = [...Object.values(WebhookTriggerEvents), WebhookTriggerEvents.BOOKING_CREATED];
    const createdAt = new Date();
    const webhook = parseWebhookEventTriggers({ id: "hook", createdAt, eventTriggers });
    expect(webhook).toEqual({ id: "hook", createdAt, eventTriggers });
    expect(webhook.createdAt).toBe(createdAt);
  });

  it.each([null, []])("projects empty storage %j to an empty logical list", (eventTriggers) => {
    expect(parseWebhookEventTriggers({ eventTriggers }).eventTriggers).toEqual([]);
  });

  it.each([
    undefined,
    {},
    "[]",
    [null],
    [["BOOKING_CREATED"]],
    ["INVALID"],
    [1],
  ])("rejects malformed or unknown events: %j", (eventTriggers) => {
    expect(() => parseWebhookEventTriggers({ eventTriggers })).toThrow();
  });
});
