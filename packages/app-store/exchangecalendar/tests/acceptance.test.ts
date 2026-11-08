import { symmetricDecrypt, symmetricEncrypt } from "@calcom/lib/crypto";
import type { CalendarServiceEvent, Person } from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The shared test setup mocks this service for web tests; this suite exercises the real EWS code.
vi.unmock("@calcom/exchangecalendar/lib/CalendarService");

const ENCRYPTION_KEY = "12345678901234567890123456789012";
const EWS_URL = "https://ews.example.com/EWS/Exchange.asmx";
const START = "2026-03-02T10:00:00.000Z";
const END = "2026-03-02T10:30:00.000Z";

const { ews, xhr, prisma, buildService } = vi.hoisted(() => {
  // biome-ignore lint/correctness/noProcessGlobal: vi.hoisted runs before imports
  globalThis.process.env.CALENDSO_ENCRYPTION_KEY = "12345678901234567890123456789012";

  const state = {
    services: [] as Array<{ version: number; Credentials: unknown; Url: unknown; XHRApi: unknown }>,
    created: [] as Appointment[],
    bound: [] as Appointment[],
    saveModes: [] as number[],
    updateCalls: [] as Array<[number, number]>,
    deleteModes: [] as number[],
    folderCalls: [] as Array<{ folder: unknown; filter: unknown; view: FolderView }>,
    folders: [] as Array<{ id: string; name: string; parentId?: string; childCount?: number }>,
    appointments: [] as Array<{ LegacyFreeBusyStatus: number; Start: DateTime; End: DateTime }>,
    appointmentCalls: [] as Array<{ folderId: FolderId; view: CalendarView }>,
    deletedItems: null as { Id: FolderId } | null,
    error: null as Error | null,
  };

  class FolderId {
    UniqueId: string;
    constructor(public value: string) {
      this.UniqueId = value;
    }
  }
  type ItemId = FolderId;
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
  class PropertySet {
    added: unknown[] = [];
    constructor(public basePropertySet?: unknown) {}
    Add(property: unknown) {
      this.added.push(property);
    }
  }
  class FolderView {
    PropertySet = new PropertySet();
    Traversal: unknown;
    constructor(public pageSize: number) {}
  }
  class SearchFilterCollection {
    filters: unknown[] = [];
    constructor(public operator: unknown) {}
    Add(filter: unknown) {
      this.filters.push(filter);
    }
  }
  class SearchFilterIsEqualTo {
    constructor(
      public property: unknown,
      public value: unknown
    ) {}
  }
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
  class Folder {
    static async Bind() {
      if (state.error) throw state.error;
      return state.deletedItems ?? { Id: new FolderId("deleted-items") };
    }
  }
  class ExchangeService {
    Credentials: unknown;
    Url: unknown;
    XHRApi: unknown;
    constructor(public version: number) {
      state.services.push(this);
    }
    async FindFolders(folder: unknown, filter: unknown, view: FolderView) {
      if (state.error) throw state.error;
      state.folderCalls.push({ folder, filter, view });
      return {
        Folders: state.folders.map((it) => ({
          Id: new FolderId(it.id),
          ParentFolderId: new FolderId(it.parentId ?? "root"),
          DisplayName: it.name,
          ChildFolderCount: it.childCount ?? 0,
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
  class SoapFaultDetails extends Error {}

  return {
    ews: {
      state,
      reset() {
        for (const value of Object.values(state)) if (Array.isArray(value)) value.length = 0;
        state.deletedItems = null;
        state.error = null;
      },
      module: {
        Appointment,
        Attendee,
        BasePropertySet: { IdOnly: "IdOnly" },
        CalendarView,
        ConflictResolutionMode: { AlwaysOverwrite: 1 },
        DateTime,
        DeleteMode: { MoveToDeletedItems: 2 },
        ExchangeService,
        Folder,
        FolderId,
        FolderSchema: {
          ParentFolderId: "ParentFolderId",
          DisplayName: "DisplayName",
          ChildFolderCount: "ChildFolderCount",
          FolderClass: "FolderClass",
        },
        FolderTraversal: { Deep: "Deep" },
        FolderView,
        ItemId: FolderId,
        LegacyFreeBusyStatus: { Free: 0 },
        LogicalOperator: { And: "And" },
        MessageBody,
        PropertySet,
        SearchFilter: { SearchFilterCollection, IsEqualTo: SearchFilterIsEqualTo },
        SendInvitationsMode: { SendToAllAndSaveCopy: 3 },
        SendInvitationsOrCancellationsMode: { SendToChangedAndSaveCopy: 5 },
        SoapFaultDetails,
        Uri,
        WebCredentials,
        WellKnownFolderName: { MsgFolderRoot: "msgfolderroot" },
      },
    },
    xhr: { instances: [] as Array<{ options: unknown; calls: Array<[string, string]> }> },
    prisma: { credential: { create: vi.fn() } },
    buildService: vi.fn(),
  };
});

vi.mock("ews-javascript-api", () => ews.module);
vi.mock("@calcom/prisma", () => ({ default: prisma }));
vi.mock("../lib", () => ({ BuildCalendarService: buildService }));
vi.mock("@calcom/lib/server/defaultResponder", () => ({ defaultResponder: (handler: unknown) => handler }));
vi.mock("@ewsjs/xhr", () => ({
  XhrApi: class {
    options: unknown;
    calls: Array<[string, string]> = [];
    constructor(options: unknown) {
      this.options = options;
      xhr.instances.push(this);
    }
    useNtlmAuthentication(username: string, password: string) {
      this.calls.push([username, password]);
      return this;
    }
  },
}));

import { getHandler } from "../api/_postAdd";
import BuildCalendarService from "../lib/CalendarService";

function person(email: string): Person {
  return { name: email, email, timeZone: "UTC", language: {} as Person["language"] };
}

const payloadDefaults = {
  url: EWS_URL,
  username: "owner@example.com",
  password: "s3cret",
  authenticationMethod: 0,
  exchangeVersion: 7,
  useCompression: false,
};

function credential(overrides: Partial<typeof payloadDefaults> = {}): CredentialPayload {
  const payload = { ...payloadDefaults, ...overrides };
  return {
    id: 1,
    appId: "exchange",
    type: "exchange_calendar",
    userId: 1,
    user: { email: "owner@example.com" },
    teamId: null,
    key: symmetricEncrypt(JSON.stringify(payload), ENCRYPTION_KEY),
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
  const res = { statusCode: 200, body: undefined as unknown } as unknown as FakeResponse;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

function request(body: unknown): NextApiRequest {
  return {
    method: "POST",
    body,
    session: { user: { id: 7, email: "owner@example.com" } },
  } as unknown as NextApiRequest;
}

describe("legacy Exchange credential add", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    prisma.credential.create.mockResolvedValue({ id: 1 });
    buildService.mockReturnValue({ listCalendars: vi.fn().mockResolvedValue([]) });
  });

  it("stores the encrypted form with Exchange 2016 defaults and returns only the installed URL", async () => {
    const body = { url: EWS_URL, username: "owner@example.com", password: "s3cret" };
    const res = response();

    await getHandler(request(body), res as unknown as NextApiResponse);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ url: "/apps/installed" });
    expect(prisma.credential.create.mock.calls[0][0].data).toMatchObject({
      type: "exchange_calendar",
      appId: "exchange",
      userId: 7,
      teamId: null,
      invalid: false,
      delegationCredentialId: null,
    });
    expect(
      JSON.parse(symmetricDecrypt(prisma.credential.create.mock.calls[0][0].data.key, ENCRYPTION_KEY))
    ).toEqual({ ...body, authenticationMethod: 0, exchangeVersion: 7, useCompression: false });
    expect(String(prisma.credential.create.mock.calls[0][0].data.key)).not.toContain("s3cret");
  });

  it("rejects an invalid email or unknown field before contacting Exchange", async () => {
    await expect(
      getHandler(
        request({ url: EWS_URL, username: "not-an-email", password: "s3cret" }),
        response() as unknown as NextApiResponse
      )
    ).rejects.toThrow();
    await expect(
      getHandler(
        request({ url: EWS_URL, username: "owner@example.com", password: "s3cret", extra: true }),
        response() as unknown as NextApiResponse
      )
    ).rejects.toThrow();

    expect(buildService).not.toHaveBeenCalled();
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });

  it("surfaces a SOAP fault and otherwise hides the failure behind the generic message", async () => {
    const soapFault = response();
    buildService.mockReturnValue({
      listCalendars: vi.fn().mockRejectedValue(new ews.module.SoapFaultDetails("Mailbox not found")),
    });
    await getHandler(
      request({ url: EWS_URL, username: "owner@example.com", password: "s3cret" }),
      soapFault as unknown as NextApiResponse
    );
    expect(soapFault.statusCode).toBe(500);
    expect(soapFault.body).toEqual({ message: "Mailbox not found" });

    const generic = response();
    buildService.mockReturnValue({ listCalendars: vi.fn().mockRejectedValue(new Error("socket hang up")) });
    await getHandler(
      request({ url: EWS_URL, username: "owner@example.com", password: "s3cret" }),
      generic as unknown as NextApiResponse
    );
    expect(generic.statusCode).toBe(500);
    expect(generic.body).toEqual({ message: "Could not add this exchange account" });
    expect(prisma.credential.create).not.toHaveBeenCalled();
  });
});

describe("legacy Exchange EWS calendar service", () => {
  beforeEach(() => {
    ews.reset();
    xhr.instances.length = 0;
    ews.state.deletedItems = { Id: new ews.module.FolderId("deleted-items") };
  });

  it("listCalendars searches appointment folders deeply and excludes deleted items", async () => {
    ews.state.folders = [
      { id: "cal-1", name: "Work", childCount: 2 },
      { id: "deleted-child", parentId: "deleted-items", name: "Old event" },
    ];

    const calendars = await BuildCalendarService(credential()).listCalendars();

    expect(calendars).toEqual([
      { externalId: "cal-1", name: "Work", primary: true, integration: "exchange_calendar" },
    ]);
    const call = ews.state.folderCalls[0];
    expect(call.folder).toBe("msgfolderroot");
    expect(call.filter).toMatchObject({
      operator: "And",
      filters: [{ property: "FolderClass", value: "IPF.Appointment" }],
    });
    expect(call.view.Traversal).toBe("Deep");
  });

  it("getAvailability only queries selected calendars and drops free appointments", async () => {
    ews.state.folders = [
      { id: "cal-1", name: "Work" },
      { id: "cal-2", name: "Personal" },
    ];
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

    const availability = await BuildCalendarService(credential()).getAvailability({
      dateFrom: "2026-03-02T00:00:00.000Z",
      dateTo: "2026-03-03T00:00:00.000Z",
      selectedCalendars: [
        { integration: "exchange_calendar", externalId: "cal-1" },
        { integration: "exchange_calendar", externalId: "missing" },
      ],
      mode: "slots",
    });

    expect(ews.state.appointmentCalls.map((call) => call.folderId.value)).toEqual(["cal-1"]);
    expect(availability).toEqual([
      { start: new Date("2026-03-02T09:00:00.000Z"), end: new Date("2026-03-02T09:30:00.000Z") },
    ]);
  });

  it("createEvent saves the event and attendees with the legacy defaults", async () => {
    const service = BuildCalendarService(credential());

    const result = await service.createEvent(
      event({
        description: "Agenda",
        location: "Room 1",
        team: { id: 1, name: "Team", members: [person("teammate@example.com")] },
      }),
      1
    );

    expect(ews.state.services[0].version).toBe(7);
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
    expect(result).toMatchObject({ uid: "saved-item", id: "saved-item" });
  });

  it("updateEvent and deleteEvent bind the item and use the legacy EWS modes", async () => {
    const service = BuildCalendarService(credential());

    await service.updateEvent("item-1", event({ location: null }));
    await service.deleteEvent("item-2", event());

    expect(ews.state.bound[0].Id.UniqueId).toBe("item-1");
    expect(ews.state.bound[0]).toMatchObject({ Location: "", Body: { content: "" } });
    expect(ews.state.updateCalls).toEqual([[1, 5]]);
    expect(ews.state.bound[1].Id.UniqueId).toBe("item-2");
    expect(ews.state.deleteModes).toEqual([2]);
  });
  it("NTLM authentication installs the NTLM XHR transport", async () => {
    const service = BuildCalendarService(credential({ authenticationMethod: 1 }));

    await service.listCalendars();

    expect(xhr.instances).toHaveLength(1);
    expect(xhr.instances[0].options).toEqual({ rejectUnauthorized: false });
    expect(xhr.instances[0].calls).toEqual([["owner@example.com", "s3cret"]]);
    expect(ews.state.services[0].XHRApi).toBe(xhr.instances[0]);
  });

  it("rethrows EWS failures so the caller can report a failed integration", async () => {
    const failure = new Error("EWS unavailable");
    ews.state.error = failure;
    const service = BuildCalendarService(credential());

    await expect(service.listCalendars()).rejects.toBe(failure);
    await expect(service.createEvent(event(), 1)).rejects.toBe(failure);
  });
});
