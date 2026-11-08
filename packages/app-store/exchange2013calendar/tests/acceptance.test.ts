import { symmetricDecrypt, symmetricEncrypt } from "@calcom/lib/crypto";
import type { CalendarServiceEvent, Person } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The shared test setup mocks these services for web tests; this suite exercises the real EWS code.
// Exchange 2016 is a copy of this provider with a different version enum, so both are exercised here.
vi.unmock("@calcom/exchange2013calendar/lib/CalendarService");
vi.unmock("@calcom/exchange2016calendar/lib/CalendarService");

const ENCRYPTION_KEY = "12345678901234567890123456789012";
const EWS_URL = "https://ews.example.com/EWS/Exchange.asmx";
const START = "2026-03-02T10:00:00.000Z";
const END = "2026-03-02T10:30:00.000Z";

const { ews, prisma, buildService } = vi.hoisted(() => {
  // biome-ignore lint/correctness/noProcessGlobal: vi.hoisted runs before imports
  globalThis.process.env.CALENDSO_ENCRYPTION_KEY = "12345678901234567890123456789012";

  const state = {
    services: [] as Array<{ version: number; Credentials: unknown; Url: unknown }>,
    created: [] as Appointment[],
    bound: [] as Appointment[],
    saveModes: [] as number[],
    updateCalls: [] as Array<[number, number]>,
    deleteModes: [] as number[],
    folderCalls: [] as Array<{ folder: unknown; view: { pageSize: number } }>,
    folders: [] as Array<{ id: string; name: string }>,
    childFolders: [] as Array<{ id: string; name: string }>,
    appointments: [] as Array<{ LegacyFreeBusyStatus: number; Start: DateTime; End: DateTime }>,
    appointmentCalls: [] as Array<{ folderId: FolderId; view: CalendarView }>,
    error: null as Error | null,
  };

  class FolderId {
    UniqueId: string;
    constructor(public value: string) {
      this.UniqueId = value;
    }
  }
  class ItemId {
    constructor(public value: string) {}
  }
  class DateTime {
    constructor(public value: string) {}
    static Parse(value: string) {
      return new DateTime(value);
    }
    ToISOString() {
      return new Date(this.value).toISOString();
    }
  }
  class CalendarView {
    constructor(
      public start: DateTime,
      public end: DateTime
    ) {}
  }
  class FolderView {
    constructor(public pageSize: number) {}
  }
  class PropertySet {}
  class Attendee {
    constructor(public email: string) {}
  }
  class AttendeeCollection {
    items: Attendee[] = [];
    Add(attendee: Attendee) {
      this.items.push(attendee);
    }
  }
  class MessageBody {
    constructor(public content: string) {}
  }
  class Uri {
    constructor(public value: string) {}
  }
  class WebCredentials {
    constructor(
      public username: string,
      public password: string
    ) {}
  }
  class ExchangeService {
    Credentials: unknown;
    Url: unknown;
    XHRApi: unknown;
    constructor(public version: number) {
      state.services.push(this);
    }
    async FindFolders(folder: unknown, view: FolderView) {
      if (state.error) throw state.error;
      state.folderCalls.push({ folder, view });
      const folders = folder instanceof FolderId ? state.childFolders : state.folders;
      return {
        Folders: folders.map((it) => ({
          Id: new FolderId(it.id),
          DisplayName: it.name,
          FolderClass: "IPF.Appointment",
        })),
      };
    }
    async FindAppointments(folderId: FolderId, view: CalendarView) {
      if (state.error) throw state.error;
      state.appointmentCalls.push({ folderId, view });
      return { Items: state.appointments };
    }
  }
  class Appointment {
    Subject = "";
    Start: DateTime | null = null;
    End: DateTime | null = null;
    Location = "";
    Body: MessageBody | null = null;
    RequiredAttendees = new AttendeeCollection();
    Id = { UniqueId: "saved-item" };
    constructor(public Service: ExchangeService) {
      state.created.push(this);
    }
    async Save(mode: number) {
      if (state.error) throw state.error;
      state.saveModes.push(mode);
    }
    async Update(conflict: number, send: number) {
      if (state.error) throw state.error;
      state.updateCalls.push([conflict, send]);
    }
    async Delete(mode: number) {
      if (state.error) throw state.error;
      state.deleteModes.push(mode);
    }
    static async Bind(service: ExchangeService, itemId: ItemId) {
      if (state.error) throw state.error;
      const appointment = new Appointment(service);
      appointment.Id.UniqueId = itemId.value;
      state.bound.push(appointment);
      return appointment;
    }
  }

  return {
    ews: {
      state,
      reset() {
        for (const value of Object.values(state)) if (Array.isArray(value)) value.length = 0;
        state.error = null;
      },
      module: {
        Appointment,
        Attendee,
        CalendarView,
        ConflictResolutionMode: { AlwaysOverwrite: 1 },
        DateTime,
        DeleteMode: { MoveToDeletedItems: 2 },
        ExchangeService,
        ExchangeVersion: { Exchange2013: 4, Exchange2016: 7 },
        FolderId,
        FolderView,
        ItemId,
        LegacyFreeBusyStatus: { Free: 0 },
        MessageBody,
        PropertySet,
        SendInvitationsMode: { SendToAllAndSaveCopy: 3 },
        SendInvitationsOrCancellationsMode: { SendToAllAndSaveCopy: 4 },
        Uri,
        WebCredentials,
        WellKnownFolderName: { MsgFolderRoot: "msgfolderroot" },
      },
    },
    prisma: {
      user: { findFirstOrThrow: vi.fn() },
      credential: { create: vi.fn() },
    },
    buildService: vi.fn(),
  };
});

vi.mock("ews-javascript-api", () => ews.module);
vi.mock("@calcom/prisma", () => ({ default: prisma }));
vi.mock("../lib", () => ({ BuildCalendarService: buildService }));
vi.mock("../../exchange2016calendar/lib", () => ({ BuildCalendarService: buildService }));
// The responder adds tracing and Sentry wrapping; the handler's own success and error paths are the subject.
vi.mock("@calcom/lib/server/defaultResponder", () => ({ defaultResponder: (handler: unknown) => handler }));

import handler2016 from "../../exchange2016calendar/api/add";
import Build2016 from "../../exchange2016calendar/lib/CalendarService";
import handler2013 from "../api/add";
import Build2013 from "../lib/CalendarService";

function person(email: string): Person {
  return { name: email, email, timeZone: "UTC", language: {} as Person["language"] };
}

function credential(type: string): CredentialPayload {
  return {
    id: 1,
    appId: "exchange-calendar",
    type,
    userId: 1,
    user: { email: "owner@example.com" },
    teamId: null,
    key: symmetricEncrypt(
      JSON.stringify({ username: "owner@example.com", password: "s3cret", url: EWS_URL }),
      ENCRYPTION_KEY
    ),
    encryptedKey: null,
    invalid: false,
    delegationCredentialId: null,
  };
}

function event(overrides: Partial<CalendarServiceEvent> = {}): CalendarServiceEvent {
  return {
    type: "exchange_calendar",
    title: "Product sync",
    startTime: START,
    endTime: END,
    organizer: person("owner@example.com"),
    attendees: [person("guest@example.com")],
    calendarDescription: "Product sync",
    ...overrides,
  };
}

type FakeResponse = {
  statusCode: number;
  body: unknown;
  status: (code: number) => FakeResponse;
  json: (body: unknown) => FakeResponse;
};

function response(): FakeResponse {
  const res: FakeResponse = {
    statusCode: 200,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function request(body: unknown): NextApiRequest {
  return { method: "POST", body, session: { user: { id: 7 } } } as unknown as NextApiRequest;
}

const providers = [
  {
    label: "Exchange 2013",
    handler: handler2013,
    build: Build2013,
    type: "exchange2013_calendar",
    appId: "exchange2013-calendar",
    version: 4,
  },
  {
    label: "Exchange 2016",
    handler: handler2016,
    build: Build2016,
    type: "exchange2016_calendar",
    appId: "exchange2016-calendar",
    version: 7,
  },
];

describe.each(providers)("$label add flow", ({ handler, type, appId, build }) => {
  beforeEach(() => {
    vi.resetAllMocks();
    ews.reset();
    prisma.user.findFirstOrThrow.mockResolvedValue({ id: 7, email: "owner@example.com" });
    prisma.credential.create.mockResolvedValue({ id: 1 });
    buildService.mockImplementation(() => build(credential(type)));
  });

  it("stores the encrypted credential and returns only the installed app URL", async () => {
    const res = response();
    const body = { username: "owner@example.com", password: "s3cret", url: EWS_URL };

    const result = await handler(request(body), res as unknown as NextApiResponse);

    expect(result).toEqual({ url: `/apps/installed/calendar?hl=${appId}` });
    expect(JSON.stringify(result)).not.toContain("s3cret");
    expect(buildService).toHaveBeenCalledWith(
      expect.objectContaining({ user: { email: "owner@example.com" } })
    );
    expect(buildService.mock.calls[0][0].key).toBe(prisma.credential.create.mock.calls[0][0].data.key);
    expect(prisma.credential.create.mock.calls[0][0].data).toMatchObject({
      type,
      appId,
      userId: 7,
      teamId: null,
      invalid: false,
      delegationCredentialId: null,
    });
    expect(
      JSON.parse(symmetricDecrypt(prisma.credential.create.mock.calls[0][0].data.key, ENCRYPTION_KEY))
    ).toEqual(body);
    expect(String(prisma.credential.create.mock.calls[0][0].data.key)).not.toContain("s3cret");
  });

  it("rejects malformed and extra fields before contacting Exchange", async () => {
    await expect(
      handler(
        request({ username: "owner@example.com", password: "s3cret", url: "not-a-url" }),
        response() as unknown as NextApiResponse
      )
    ).rejects.toThrow();
    await expect(
      handler(
        request({ username: "owner@example.com", password: "s3cret", url: EWS_URL, extra: true }),
        response() as unknown as NextApiResponse
      )
    ).rejects.toThrow();

    expect(prisma.user.findFirstOrThrow).not.toHaveBeenCalled();
    expect(buildService).not.toHaveBeenCalled();
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("reports a failed calendar probe without storing the credential", async () => {
    buildService.mockReturnValue({ listCalendars: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) });
    const res = response();

    await handler(
      request({ username: "owner@example.com", password: "s3cret", url: EWS_URL }),
      res as unknown as NextApiResponse
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: "Could not add this exchange account" });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });
});

describe.each(providers)("$label EWS calendar service", ({ build, type, version }) => {
  beforeEach(() => {
    ews.reset();
  });

  it("createEvent saves the event, attendees and team members through EWS", async () => {
    const service = build(credential(type));

    const result = await service.createEvent(
      event({
        description: "Agenda",
        location: "Room 1",
        team: { id: 1, name: "Team", members: [person("teammate@example.com")] },
      }),
      1
    );

    expect(ews.state.services[0].version).toBe(version);
    expect(ews.state.services[0].Credentials).toEqual({ username: "owner@example.com", password: "s3cret" });
    expect(ews.state.services[0].Url).toEqual({ value: EWS_URL });
    expect(ews.state.created[0]).toMatchObject({
      Subject: "Product sync",
      Location: "Room 1",
      Start: { value: START },
      End: { value: END },
      Body: { content: "Agenda" },
    });
    expect(ews.state.created[0].RequiredAttendees.items.map((attendee) => attendee.email)).toEqual([
      "guest@example.com",
      "teammate@example.com",
    ]);
    expect(ews.state.saveModes).toEqual([3]);
    expect(result).toMatchObject({ uid: "saved-item", id: "saved-item", type: "", url: "", password: "" });
  });

  it("listCalendars marks the calendar parent as primary and its children as secondary", async () => {
    ews.state.folders = [{ id: "calendars", name: "Calendars" }];
    ews.state.childFolders = [{ id: "cal-1", name: "Work" }];

    const calendars = await build(credential(type)).listCalendars();

    expect(calendars).toEqual([
      { externalId: "calendars", name: "Calendars", primary: true, integration: type },
      { externalId: "cal-1", name: "Work", primary: false, integration: type },
    ]);
    expect(ews.state.folderCalls[0].folder).toBe("msgfolderroot");
    expect(ews.state.folderCalls[0].view.pageSize).toBe(1000);
  });

  it("getAvailability only queries selected calendars and drops free appointments", async () => {
    ews.state.folders = [{ id: "calendars", name: "Calendars" }];
    ews.state.childFolders = [{ id: "cal-1", name: "Work" }];
    ews.state.appointments = [
      {
        LegacyFreeBusyStatus: 1,
        Start: new ews.module.DateTime("2026-03-02T09:00:00.000Z"),
        End: new ews.module.DateTime("2026-03-02T09:30:00.000Z"),
      },
      {
        LegacyFreeBusyStatus: 0,
        Start: new ews.module.DateTime("2026-03-02T11:00:00.000Z"),
        End: new ews.module.DateTime("2026-03-02T12:00:00.000Z"),
      },
    ];

    const availability = await build(credential(type)).getAvailability({
      dateFrom: "2026-03-02T00:00:00.000Z",
      dateTo: "2026-03-03T00:00:00.000Z",
      selectedCalendars: [
        { integration: type, externalId: "cal-1" },
        { integration: type, externalId: "missing" },
      ],
      mode: "slots",
    });

    expect(ews.state.appointmentCalls.map((call) => call.folderId.value)).toEqual(["cal-1"]);
    expect(availability).toEqual([
      { start: new Date("2026-03-02T09:00:00.000Z"), end: new Date("2026-03-02T09:30:00.000Z") },
    ]);
  });

  it("updateEvent and deleteEvent bind the item and send the expected EWS modes", async () => {
    const service = build(credential(type));

    await service.updateEvent("item-1", event({ location: null, description: null }));
    await service.deleteEvent("item-2", event());

    expect(ews.state.bound[0].Id.UniqueId).toBe("item-1");
    expect(ews.state.bound[0]).toMatchObject({ Location: "Location not defined!", Body: { content: "" } });
    expect(ews.state.updateCalls).toEqual([[1, 4]]);
    expect(ews.state.bound[1].Id.UniqueId).toBe("item-2");
    expect(ews.state.deleteModes).toEqual([2]);
  });

  it("rethrows EWS failures so the caller can report a failed integration", async () => {
    const failure = new Error("EWS unavailable");
    ews.state.error = failure;
    const service = build(credential(type));

    await expect(service.listCalendars()).rejects.toBe(failure);
    await expect(service.createEvent(event(), 1)).rejects.toBe(failure);
  });
});
