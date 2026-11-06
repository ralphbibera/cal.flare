import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import kysely from "@calcom/kysely";
import prisma from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getBookings } from "./get.handler";

let root: string;
let runtime: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "booking-list-concurrency-"));
  execFileSync("bun", ["packages/prisma/migrate-d1.mts", "--local-only", "--persist-to", root]);
  const { worker } = (await import(`${process.cwd()}/apps/web/cloudflare.config.ts`)).default;
  runtime = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    resourcePersistencePath: join(root, "v3"),
    workers: [
      {
        config: {
          name: worker.name,
          compatibilityDate: worker.compatibilityDate,
          compatibilityFlags: worker.compatibilityFlags,
          env: { DB: worker.env.DB },
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": { type: "esm", contents: "export default {fetch(){return new Response()}}" },
            },
          },
        },
      },
    ],
  });
  db = await runtime.getD1Database("DB");
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

it("does not mix attendee and host visibility across concurrent association changes", async () => {
  await db.batch([
    db.prepare(
      "INSERT INTO users (id, uuid, email) VALUES (1, 'owner', 'owner@example.com'), (2, 'viewer', 'viewer@example.com')"
    ),
    db.prepare(
      "INSERT INTO EventType (id, title, slug, length, seatsPerTimeSlot, seatsShowAttendees) VALUES (1, 'Seats', 'seats', 30, 3, 0)"
    ),
    db.prepare(
      "INSERT INTO Booking (id, uid, userId, eventTypeId, title, startTime, endTime) VALUES (1, 'race', 1, 1, 'Seats', '2045-01-01T00:00:00.000+00:00', '2045-01-01T00:30:00.000+00:00')"
    ),
    db.prepare(
      "INSERT INTO Attendee (id, email, name, timeZone, bookingId) VALUES (1, 'viewer@example.com', 'Viewer', 'UTC', 1), (2, 'private@example.com', 'Private', 'UTC', 1)"
    ),
    db.prepare("INSERT INTO BookingSeat (referenceUid, bookingId, attendeeId) VALUES ('seat', 1, 1)"),
  ]);
  const queries: string[] = [];
  let changed = false;
  const associationChanged = Promise.withResolvers<void>();
  const changeAssociation = async () => {
    if (changed) return;
    changed = true;
    await db.batch([
      db.prepare("INSERT INTO Host (userId, eventTypeId) VALUES (2, 1)"),
      db.prepare("DELETE FROM Attendee WHERE email = 'private@example.com' AND bookingId = 1"),
    ]);
    associationChanged.resolve();
  };
  const instrument = (statement: D1PreparedStatement, query: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => instrument(target.bind(...values), query);
        if (property === "all")
          return async () => {
            const result = await target.all();
            if (query.includes('as "seatsReferences"')) await changeAssociation();
            return result;
          };
        if (property === "raw")
          return async (options?: { columnNames?: boolean }) => {
            if (query.includes("`main`.`Host`")) await associationChanged.promise;
            const result = options?.columnNames
              ? await target.raw({ columnNames: true })
              : await target.raw({ columnNames: false });
            if (query.includes("`main`.`Attendee`")) await changeAssociation();
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const observed = new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => {
          queries.push(query);
          return instrument(target.prepare(query), query);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const result = await withD1Database({ DB: observed }, () =>
    getBookings({
      user: { id: 2, email: "viewer@example.com" },
      prisma,
      kysely,
      bookingListingByStatus: ["upcoming"],
      filters: {},
      take: 10,
      skip: 0,
    })
  );
  expect(changed).toBe(true);
  expect(queries[0]).toContain("union_subquery");
  expect(queries[1]).toContain("count(distinct");
  expect(queries[2]).toContain("Booking");
  expect(result.bookings[0].attendees.map(({ email }) => email)).toEqual(["viewer@example.com"]);
});
