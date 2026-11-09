/* eslint-disable @typescript-eslint/no-explicit-any */

import i18nMock from "../__mocks__/libServerI18n";
import prismock from "../__mocks__/prisma";
import { prisma } from "@calcom/prisma";
import type { TFunction } from "i18next";
import { v4 as uuidv4 } from "uuid";
import { vi } from "vitest";
import "vitest-fetch-mock";
import { getOrCreateCalendarServiceMock, mockVideoAdapterRegistry } from "./bookingScenarioMocks";
import process from "node:process";
import { appStoreMetadata } from "@calcom/app-store/appStoreMetaData";
import { type WeekDays, weekdayToWeekIndex } from "@calcom/lib/dayjs";
import type { IntervalLimit } from "@calcom/lib/intervalLimits/intervalLimitSchema";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";
import type { Attendee, Booking, BookingReference, Membership, Prisma, Team } from "@calcom/prisma/client";
import type {
  BookingStatus,
  PaymentOption,
  SchedulingType,
  SMSLockState,
  TimeUnit,
} from "@calcom/prisma/enums";
import { WebhookTriggerEvents } from "@calcom/prisma/enums";
import type {
  EventTypeMetaDataSchema,
  eventTypeBookingFields,
  teamMetadataSchema,
  userMetadataType,
} from "@calcom/prisma/zod-utils";
import type { AppMeta } from "@calcom/types/App";
import type {
  Calendar,
  CalendarEvent,
  EventBusyDate,
  IntegrationCalendar,
  NewCalendarEventType,
} from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { VideoApiAdapter } from "@calcom/types/VideoApiAdapter";
import { z } from "zod";
import type { getMockRequestDataForBooking } from "./getMockRequestDataForBooking";
import { getMockPaymentService } from "./MockPaymentService";

const isD1Scenario = () => process.env.CALFLARE_D1_SCENARIO === "true";

vi.mock("@calcom/features/bookings/lib/handleNewBooking/createBookingInD1", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@calcom/features/bookings/lib/handleNewBooking/createBookingInD1")>();
  if (isD1Scenario()) return actual;
  return {
    ...actual,
    createBookingInD1: async ({ data, cancellation }: Parameters<typeof actual.createBookingInD1>[0]) => {
      if (cancellation) await prismock.booking.update(cancellation);
      return prismock.booking.create({ data, include: actual.bookingRelations });
    },
  };
});

vi.mock(
  "@calcom/features/bookings/lib/handleSeats/reschedule/owner/moveSeatedAttendeesInD1",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@calcom/features/bookings/lib/handleSeats/reschedule/owner/moveSeatedAttendeesInD1")
      >();
    if (isD1Scenario()) return actual;
    return {
      ...actual,
      moveSeatedAttendeesInD1: async ({
        bookingId,
        attendeeIdsToMove,
        attendeeIdsToDelete,
      }: {
        bookingId: number;
        attendeeIdsToMove: number[];
        attendeeIdsToDelete: number[];
      }) => {
        for (const id of attendeeIdsToMove) {
          await prismock.attendee.update({
            where: { id },
            data: {
              bookingId,
              bookingSeat: {
                upsert: { create: { referenceUid: `seat-${id}`, bookingId }, update: { bookingId } },
              },
            },
          });
        }
        await prismock.attendee.deleteMany({ where: { id: { in: attendeeIdsToDelete } } });
      },
    };
  }
);

vi.mock(
  "@calcom/features/bookings/lib/handleSeats/reschedule/attendee/moveSeatedAttendeeInD1",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@calcom/features/bookings/lib/handleSeats/reschedule/attendee/moveSeatedAttendeeInD1")
      >();
    if (isD1Scenario()) return actual;
    return {
      ...actual,
      moveSeatedAttendeeInD1: async ({
        attendeeId,
        bookingSeatId,
        bookingId,
      }: {
        attendeeId: number;
        bookingSeatId: number;
        bookingId: number;
      }) => {
        await prismock.attendee.update({ where: { id: attendeeId }, data: { bookingId } });
        await prismock.bookingSeat.update({ where: { id: bookingSeatId }, data: { bookingId } });
      },
    };
  }
);

vi.mock("@calcom/features/webhooks/lib/queryWebhookRows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/features/webhooks/lib/queryWebhookRows")>();
  if (isD1Scenario()) return actual;
  return {
    ...actual,
    queryWebhookSubscribers: async (
      ...[client, predicate, order]: Parameters<typeof actual.queryWebhookSubscribers>
    ) => {
      const scope = z
        .tuple([z.string(), z.number(), z.number(), z.number(), z.string(), z.string()])
        .safeParse(predicate.values);
      if (
        order ||
        !scope.success ||
        !predicate.sql.includes('AND (platform = true OR "userId" = ? OR "eventTypeId" = ?')
      ) {
        return actual.queryWebhookSubscribers(client, predicate, order);
      }
      const [eventsJson, userId, eventTypeId, parentId, teamsJson, oAuthClientId] = scope.data;
      const eventsSchema = z.array(z.nativeEnum(WebhookTriggerEvents));
      const events = eventsSchema.parse(JSON.parse(eventsJson));
      const teamIds = z.array(z.number()).parse(JSON.parse(teamsJson));
      const webhooks = await prismock.webhook.findMany({
        where: {
          active: true,
          OR: [
            { platform: true },
            { userId },
            { eventTypeId },
            { eventTypeId: parentId },
            { teamId: { in: teamIds } },
            { platformOAuthClientId: oAuthClientId },
          ],
        },
        select: {
          id: true,
          subscriberUrl: true,
          payloadTemplate: true,
          appId: true,
          secret: true,
          time: true,
          timeUnit: true,
          eventTriggers: true,
          version: true,
        },
      });
      return webhooks
        .map((webhook) => ({ ...webhook, eventTriggers: eventsSchema.parse(webhook.eventTriggers ?? []) }))
        .filter((webhook) => events.every((event) => webhook.eventTriggers.includes(event)));
    },
  };
});

type NonNullableVideoApiAdapter = NonNullable<VideoApiAdapter>;

const isIntegrationMode = process.env.CALFLARE_D1_SCENARIO === "true";

type Fields = z.infer<typeof eventTypeBookingFields>;

logger.settings.minLevel = 1;
const log = logger.getSubLogger({ prefix: ["[bookingScenario]"] });

type InputWebhook = {
  id?: string;
  appId: string | null;
  userId?: number | null;
  teamId?: number | null;
  eventTypeId?: number;
  active: boolean;
  eventTriggers: WebhookTriggerEvents[];
  subscriberUrl: string;
  time?: number | null;
  timeUnit?: TimeUnit | null;
};

type InputPayment = {
  id?: number;
  uid: string;
  appId?: string | null;
  bookingId: number;
  amount: number;
  fee: number;
  currency: string;
  success: boolean;
  refunded: boolean;
  data: Prisma.InputJsonValue;
  externalId: string;
  paymentOption?: PaymentOption;
};

type InputHostLocation = {
  type: string;
  credentialId?: number | null;
  link?: string | null;
  address?: string | null;
  phoneNumber?: string | null;
};

type InputHost = {
  userId: number;
  isFixed?: boolean;
  scheduleId?: number | null;
  groupId?: string | null;
  location?: InputHostLocation | null;
};

type InputSelectedSlot = {
  eventTypeId: number;
  userId: number;
  slotUtcStartDate: Date;
  slotUtcEndDate: Date;
  uid: string;
  releaseAt: Date;
  isSeat?: boolean;
};

/**
 * Data to be mocked
 */
export type ScenarioData = {
  /**
   * Prisma would return these eventTypes
   */
  eventTypes: InputEventType[];
  /**
   * Prisma would return these users
   */
  users: InputUser[];
  /**
   * Prisma would return these apps
   */
  apps?: Partial<AppMeta>[];
  bookings?: InputBooking[];
  webhooks?: InputWebhook[];
  payment?: InputPayment[];
  selectedSlots?: InputSelectedSlot[];
};

type InputCredential = typeof TestData.credentials.google & {
  id?: number;
};

type InputSelectedCalendar = (typeof TestData.selectedCalendars)[keyof typeof TestData.selectedCalendars] & {
  eventTypeId?: number | null;
};

type InputUser = Omit<typeof TestData.users.example, "defaultScheduleId"> & {
  id: number;
  defaultScheduleId?: number | null;
  credentials?: InputCredential[];
  organizationId?: number | null;
  selectedCalendars?: InputSelectedCalendar[];
  teams?: {
    membership: Partial<Membership>;
    team: {
      id: number;
      name: string;
      slug: string;
      parentId?: number;
      isPrivate?: boolean;
    };
  }[];
  schedules: {
    // Allows giving id in the input directly so that it can be referenced somewhere else as well
    id?: number;
    name: string;
    availability: {
      days: number[];
      startTime: Date;
      endTime: Date;
      date: string | null;
    }[];
    timeZone: string;
  }[];
  destinationCalendar?: Prisma.DestinationCalendarCreateInput;
  weekStart?: string;
  profiles?: Prisma.ProfileUncheckedCreateWithoutUserInput[];
  completedOnboarding?: boolean;
  outOfOffice?: {
    dateRanges: {
      start: string;
      end: string;
    }[];
  };
  requiresBookerEmailVerification?: boolean;
  secondaryEmails?: { email: string; emailVerified: Date | null }[];
};

export type InputEventType = {
  id: number;
  title?: string;
  length?: number;
  offsetStart?: number;
  slotInterval?: number;
  userId?: number;
  minimumBookingNotice?: number;
  useEventLevelSelectedCalendars?: boolean;
  users?: { id: number }[];
  hosts?: InputHost[];
  hostGroups?: { id: string; name: string }[];
  schedulingType?: SchedulingType;
  parent?: { id: number };
  beforeEventBuffer?: number;
  afterEventBuffer?: number;
  teamId?: number | null;
  team?: {
    id?: number | null;
    parentId?: number | null;
    bookingLimits?: IntervalLimit;
    includeManagedEventsInLimits?: boolean;
  };
  requiresConfirmation?: boolean;
  destinationCalendar?: Prisma.DestinationCalendarCreateInput;
  schedule?: InputUser["schedules"][number] | null;
  bookingLimits?: IntervalLimit;
  durationLimits?: IntervalLimit;
  owner?: number;
  metadata?: z.infer<typeof EventTypeMetaDataSchema>;
  rescheduleWithSameRoundRobinHost?: boolean;
  restrictionSchedule?: {
    create: {
      name: string;
      timeZone: string;
      availability: {
        createMany: {
          data: {
            days: number[];
            startTime: Date;
            endTime: Date;
            date: string | null;
          }[];
        };
      };
      user: { connect: { id: number } };
    };
  };
  useBookerTimezone?: boolean;
  restrictionScheduleId?: number;
} & Partial<Omit<Prisma.EventTypeCreateInput, "users" | "schedule" | "bookingLimits" | "durationLimits">>;

type AttendeeBookingSeatInput = Pick<Prisma.BookingSeatCreateInput, "referenceUid" | "data">;

type WhiteListedBookingProps = {
  id?: number;
  uid?: string;
  userId?: number;
  eventTypeId: number;
  startTime: string;
  endTime: string;
  title?: string;
  status: BookingStatus;
  attendees?: {
    email: string;
    phoneNumber?: string;
    bookingSeat?: AttendeeBookingSeatInput | null;
    timeZone?: string;
  }[];
  references?: (Omit<ReturnType<typeof getMockBookingReference>, "credentialId"> & {
    // TODO: Make sure that all references start providing credentialId and then remove this intersection of optional credentialId
    credentialId?: number | null;
  })[];
  user?: { id: number };
  bookingSeat?: Prisma.BookingSeatCreateInput[];
  createdAt?: string;
};

type InputBooking = Partial<Omit<Booking, keyof WhiteListedBookingProps>> & WhiteListedBookingProps;

export const Timezones = {
  "+5:30": "Asia/Kolkata",
  "+6:00": "Asia/Dhaka",
  "-11:00": "Pacific/Pago_Pago",
};

async function addHostsToDb(eventTypes: InputEventType[]) {
  for (const eventType of eventTypes) {
    // Create host groups first if they exist
    if (eventType.hostGroups?.length) {
      await prisma.hostGroup.createMany({
        data: eventType.hostGroups.map((group) => ({
          id: group.id, // Preserve the input ID
          name: group.name,
          eventTypeId: eventType.id,
        })),
      });
    }

    if (!eventType.hosts?.length) continue;
    for (const host of eventType.hosts) {
      const data: Prisma.HostCreateInput = {
        eventType: {
          connect: {
            id: eventType.id,
          },
        },
        isFixed: host.isFixed ?? false,
        user: {
          connect: {
            id: host.userId,
          },
        },
        schedule: host.scheduleId
          ? {
              connect: {
                id: host.scheduleId,
              },
            }
          : undefined,
        group: host.groupId
          ? {
              connect: {
                id: host.groupId,
              },
            }
          : undefined,
      };

      await prisma.host.create({
        data,
      });

      if (host.location) {
        await prisma.hostLocation.create({
          data: {
            userId: host.userId,
            eventTypeId: eventType.id,
            type: host.location.type,
            credentialId: host.location.credentialId ?? null,
            link: host.location.link ?? null,
            address: host.location.address ?? null,
            phoneNumber: host.location.phoneNumber ?? null,
          },
        });
      }
    }
  }
}

export async function addEventTypesToDb(
  eventTypes: (Omit<Prisma.EventTypeCreateInput, "users" | "destinationCalendar" | "schedule"> & {
    id?: number;
    users?: ({ id: number } | undefined)[];
    userId?: number;
    hosts?: {
      user: InputUser | undefined;
      id: number;
    }[];
    destinationCalendar?: {
      create: Prisma.DestinationCalendarCreateInput;
    };
    schedule?: { create: Prisma.ScheduleCreateInput } | null | undefined;
    metadata?: z.infer<typeof EventTypeMetaDataSchema>;
    team?: { id?: number | null; bookingLimits?: IntervalLimit; includeManagedEventsInLimits?: boolean };
    restrictionSchedule?: {
      create: {
        name: string;
        timeZone: string;
        availability: {
          createMany: {
            data: {
              days: number[];
              startTime: Date;
              endTime: Date;
              date: string | null;
            }[];
          };
        };
        user: { connect: { id: number } };
      };
    };
  })[]
) {
  log.silly("TestData: Add EventTypes to DB", JSON.stringify(eventTypes));
  for (const input of eventTypes) {
    const seed = input as unknown as Record<string, unknown>;
    const {
      users: usersInput,
      hosts: _hosts,
      hostGroups: _hostGroups,
      destinationCalendar,
      schedule,
      restrictionSchedule,
      team,
      restrictionScheduleId,
      includeManagedEventsInLimits: _includeManagedEventsInLimits,
      parent,
      owner,
      ...eventTypeData
    } = seed;

    const destinationCalendarInput = destinationCalendar as
      | { create?: Prisma.DestinationCalendarCreateInput }
      | undefined;
    const scheduleInput = schedule as { create?: Prisma.ScheduleCreateInput } | null | undefined;
    const restrictionScheduleInput = restrictionSchedule as
      | {
          create: {
            name: string;
            timeZone: string;
            availability: { createMany: { data: Prisma.AvailabilityCreateManyInput[] } };
            user: { connect: { id: number } };
          };
        }
      | undefined;
    const users = Array.isArray(usersInput) ? usersInput.filter(Boolean) : undefined;
    const connectedUserIds: { id: number }[] | undefined = users
      ? users.map((user) => ({ id: (user as { id: number }).id }))
      : ((usersInput as Prisma.UserCreateNestedManyWithoutEventTypesInput | undefined)?.connect as
          | { id: number }[]
          | undefined);

    let teamId = eventTypeData.teamId as number | null | undefined;
    const teamConnection = team as
      | {
          connect?: { id: number };
          id?: number | null;
          bookingLimits?: IntervalLimit;
          includeManagedEventsInLimits?: boolean;
        }
      | undefined;
    if (teamConnection?.connect) {
      teamId = teamConnection.connect.id;
    } else if (teamConnection?.id) {
      await prisma.team.upsert({
        where: { id: teamConnection.id },
        update: {
          bookingLimits: teamConnection.bookingLimits,
          includeManagedEventsInLimits: teamConnection.includeManagedEventsInLimits,
        },
        create: {
          id: teamConnection.id,
          name: "",
          bookingLimits: teamConnection.bookingLimits,
          includeManagedEventsInLimits: teamConnection.includeManagedEventsInLimits,
        },
      });
      teamId = teamConnection.id;
    }

    const ownerConnection = owner as { connect?: { id: number } } | undefined;
    const parentConnection = parent as { connect?: { id: number } } | undefined;
    const { teamId: _teamId, ...scalars } = eventTypeData;
    if (teamId && typeof scalars.slug === "string") {
      const existingSlug = await prisma.eventType.findFirst({
        where: { teamId, slug: scalars.slug },
        select: { id: true },
      });
      if (existingSlug) scalars.slug = `${scalars.slug}-${scalars.id ?? uuidv4().slice(0, 8)}`;
    }
    const usersForCreate = Array.isArray(usersInput)
      ? !isIntegrationMode
        ? usersInput.filter(Boolean)
        : undefined
      : usersInput;
    const eventType = await prisma.eventType.create({
      data: {
        ...(scalars as Prisma.EventTypeUncheckedCreateInput),
        ...(usersForCreate ? { users: usersForCreate } : {}),
        userId: (scalars.userId as number | undefined) ?? ownerConnection?.connect?.id ?? null,
        parentId: (scalars.parentId as number | undefined) ?? parentConnection?.connect?.id ?? null,
        teamId: teamId ?? null,
      } as Prisma.EventTypeUncheckedCreateInput,
    });

    const hostUserIds = Array.isArray(_hosts)
      ? (_hosts as { userId?: number }[]).map((host) => host.userId).filter((id): id is number => !!id)
      : [];
    const userIdForSchedule =
      (scalars.userId as number | undefined) ??
      ownerConnection?.connect?.id ??
      connectedUserIds?.[0]?.id ??
      hostUserIds[0] ??
      1;
    if (isIntegrationMode) await ensureUserForForeignKey(userIdForSchedule);

    if (isIntegrationMode) {
      const ownerId = scalars.userId as number | undefined;
      const userIds = connectedUserIds?.length ? connectedUserIds : ownerId ? [{ id: ownerId }] : [];
      if (userIds.length) {
        await prisma.eventType.update({
          where: { id: eventType.id },
          data: {
            users: {
              connect: userIds,
            },
          },
        });
      }
    }

    if (destinationCalendarInput?.create) {
      const { credential, user: _dcUser, eventType: _dcEventType, ...calendarData } =
        destinationCalendarInput.create as Prisma.DestinationCalendarCreateInput & {
          credentialId?: number | null;
        };
      await prisma.destinationCalendar.create({
        data: {
          ...(calendarData as unknown as Prisma.DestinationCalendarUncheckedCreateInput),
          credentialId: credential?.connect?.id ?? calendarData.credentialId ?? null,
          eventTypeId: eventType.id,
        },
      });
    }

    if (scheduleInput?.create) {
      log.silly("TestData: Creating Schedule for EventType", JSON.stringify(schedule));
      const {
        user: _user,
        availability,
        ...scheduleData
      } = scheduleInput.create as Prisma.ScheduleCreateInput & {
        user?: { connect?: { id: number } };
        availability?: { createMany?: { data: Prisma.AvailabilityCreateManyInput[] } };
      };
      const createdSchedule = await prisma.schedule.create({
        data: {
          ...scheduleData,
          userId:
            (scheduleInput.create as { user?: { connect?: { id: number } } }).user?.connect?.id ??
            userIdForSchedule,
        },
      });
      if (availability?.createMany?.data.length) {
        await prisma.availability.createMany({
          data: normalizeAvailability(availability.createMany.data).map((entry) => ({
            ...entry,
            scheduleId: createdSchedule.id,
          })),
        });
      }
      await prisma.eventType.update({
        where: { id: eventType.id },
        data: { scheduleId: createdSchedule.id },
      });
    }

    if (restrictionScheduleInput) {
      const { user, ...restrictionData } = restrictionScheduleInput.create;
      const createdRestrictionSchedule = await prisma.schedule.create({
        data: {
          ...restrictionData,
          userId: user.connect.id,
        },
      });
      await prisma.eventType.update({
        where: { id: eventType.id },
        data: { restrictionScheduleId: createdRestrictionSchedule.id },
      });
    } else if (typeof restrictionScheduleId === "number") {
      await prisma.eventType.update({
        where: { id: eventType.id },
        data: { restrictionScheduleId },
      });
    }
  }

  const allEventTypes = await prisma.eventType.findMany({
    orderBy: { id: "asc" },
    include: {
      users: true,
      destinationCalendar: true,
      schedule: true,
      hostGroups: true,
    },
  });

  log.silly(
    "TestData: All EventTypes in DB are",
    JSON.stringify({
      eventTypes: allEventTypes,
    })
  );
  return allEventTypes;
}

export async function addEventTypes(eventTypes: InputEventType[], usersStore: InputUser[]) {
  const baseEventType = {
    title: "Base EventType Title",
    slug: "base-event-type-slug",
    timeZone: null,
    beforeEventBuffer: 0,
    afterEventBuffer: 0,
    bookingLimits: {},
    includeManagedEventsInLimits: false,
    schedulingType: null,
    length: 15,
    //TODO: What is the purpose of periodStartDate and periodEndDate? Test these?
    periodStartDate: new Date("2022-01-21T09:03:48.000Z"),
    periodEndDate: new Date("2022-01-21T09:03:48.000Z"),
    periodCountCalendarDays: false,
    periodDays: 30,
    seatsPerTimeSlot: null,
    metadata: {},
    minimumBookingNotice: 0,
    offsetStart: 0,
  };
  const foundEvents: Record<number, boolean> = {};
  const eventTypesWithUsers = eventTypes.map((eventType) => {
    if (!eventType.slotInterval && !eventType.length) {
      throw new Error("eventTypes[number]: slotInterval or length must be defined");
    }
    if (foundEvents[eventType.id]) {
      throw new Error(`eventTypes[number]: id ${eventType.id} is not unique`);
    }
    foundEvents[eventType.id] = true;
    const users =
      eventType.users?.map((userWithJustId) => {
        return usersStore.find((user) => user.id === userWithJustId.id);
      }) || [];
    const hosts =
      eventType.users?.map((host) => {
        const user = usersStore.find((user) => user.id === host.id);
        return { ...host, user };
      }) || [];
    return {
      ...baseEventType,
      ...eventType,
      users,
      hosts,
      hostGroups: eventType.hostGroups || [],
      destinationCalendar: eventType.destinationCalendar
        ? {
            create: eventType.destinationCalendar,
          }
        : eventType.destinationCalendar,
      schedule: eventType.schedule
        ? {
            create: {
              ...eventType.schedule,
              availability: {
                createMany: {
                  data: eventType.schedule.availability,
                },
              },
            },
          }
        : eventType.schedule,
      restrictionScheduleId: eventType.restrictionScheduleId ?? undefined,
      useBookerTimezone: eventType.useBookerTimezone ?? false,
      restrictionSchedule: eventType.restrictionSchedule
        ? {
            create: {
              name: eventType.restrictionSchedule.create.name,
              timeZone: eventType.restrictionSchedule.create.timeZone,
              availability: {
                createMany: {
                  data: eventType.restrictionSchedule.create.availability.createMany.data,
                },
              },
              user: { connect: { id: eventType.userId || eventType.users?.[0]?.id || 1 } },
            },
          }
        : undefined,
      owner: eventType.owner ? { connect: { id: eventType.owner } } : undefined,
      schedulingType: eventType.schedulingType,
      parent: eventType.parent ? { connect: { id: eventType.parent.id } } : undefined,
      rescheduleWithSameRoundRobinHost: eventType.rescheduleWithSameRoundRobinHost,
    };
  });
  log.silly("TestData: Creating EventType", JSON.stringify(eventTypesWithUsers));

  return await addEventTypesToDb(eventTypesWithUsers as unknown as any);
}

async function addBookingsToDb(
  bookings: (Prisma.BookingCreateInput & {
    references: any[];
    user?: { id: number };
  })[]
) {
  log.silly("TestData: Creating Bookings", JSON.stringify(bookings));

  function getDateObj(time: string | Date) {
    return time instanceof Date ? time : new Date(time);
  }

  // Make sure that we store the date in Date object always. This is to ensure consistency which Prisma does but not prismock
  log.silly("Handling Prismock bug-3");
  for (const booking of bookings) {
    const { references, attendees, user, ...bookingData } = booking as unknown as Record<string, unknown> & {
      references?: { createMany?: { data: Prisma.BookingReferenceCreateManyInput[] } };
      attendees?: { createMany?: { data: Record<string, unknown>[] } };
      user?: { id: number };
    };

    const desiredStatus = bookingData.status as Prisma.BookingUncheckedCreateInput["status"];
    const createdBooking = await prisma.booking.create({
      data: {
        ...(bookingData as unknown as Prisma.BookingUncheckedCreateInput),
        uid: (bookingData.uid as string) ?? uuidv4(),
        startTime: getDateObj(bookingData.startTime as string | Date),
        endTime: getDateObj(bookingData.endTime as string | Date),
        userId: user?.id ?? (bookingData.userId as number | undefined) ?? null,
        // The D1 client derives a unique idempotency key for every accepted booking, which rejects
        // fixtures with two accepted bookings on the same slot. Create first, then apply the status.
        status: "PENDING",
      },
    });
    if (desiredStatus && desiredStatus !== "PENDING") {
      await prisma.booking.update({
        where: { id: createdBooking.id },
        data: { status: desiredStatus },
      });
    }

    const attendeeRows = attendees?.createMany?.data ?? [];
    for (const attendee of attendeeRows) {
      const { bookingSeat, ...attendeeData } = attendee as {
        bookingSeat?: { create?: Record<string, unknown> } | Record<string, unknown>;
        [key: string]: unknown;
      };
      const seatData =
        (bookingSeat as { create?: Record<string, unknown> } | undefined)?.create ??
        (bookingSeat as Record<string, unknown> | undefined);
      await prisma.attendee.create({
        data: {
          ...(attendeeData as unknown as Prisma.AttendeeUncheckedCreateInput),
          email: (attendeeData.email as string) ?? "",
          name: (attendeeData.name as string) ?? (attendeeData.email as string) ?? "",
          timeZone: (attendeeData.timeZone as string) ?? "Europe/London",
          bookingId: createdBooking.id,
          ...(seatData
            ? {
                bookingSeat: {
                  create: {
                    ...seatData,
                    bookingId: createdBooking.id,
                  },
                },
              }
            : {}),
        } as unknown as Prisma.AttendeeCreateInput,
      });
    }

    const referenceRows = references?.createMany?.data ?? [];
    if (referenceRows.length) {
      await prisma.bookingReference.createMany({
        data: referenceRows.map((reference) => ({
          ...reference,
          bookingId: createdBooking.id,
        })),
      });
    }
  }
  log.silly(
    "TestData: Bookings as in DB",
    JSON.stringify({
      bookings: await prisma.booking.findMany({
        include: {
          references: true,
          attendees: true,
        },
      }),
    })
  );
}

export async function addBookings(bookings: InputBooking[]) {
  log.silly("TestData: Creating Bookings", JSON.stringify(bookings));
  const allBookings = [...bookings].map((booking) => {
    return {
      uid: booking.uid || uuidv4(),
      references: [],
      title: "Test Booking Title",
      ...booking,
    };
  });

  await addBookingsToDb(
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //@ts-expect-error
    allBookings.map((booking) => {
      const bookingCreate = booking;
      if (booking.references) {
        bookingCreate.references = {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          //@ts-expect-error
          createMany: {
            data: booking.references,
          },
        };
      }
      if (booking.attendees) {
        bookingCreate.attendees = {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          //@ts-expect-error
          createMany: {
            data: booking.attendees,
          },
        };
      }

      return bookingCreate;
    })
  );
}

const toJsonValue = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

function normalizeAvailability<T extends { date?: unknown }>(rows: T[]) {
  return rows.map((row) => ({ ...row, date: row.date ? new Date(row.date as string) : null }));
}

async function ensureUserForForeignKey(userId: number) {
  await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: {
      id: userId,
      email: `placeholder-${userId}@calflare.test`,
      username: `placeholder-${userId}`,
    },
  });
}

async function ensureTeamForForeignKey(teamId: number) {
  await prisma.team.upsert({
    where: { id: teamId },
    update: {},
    create: { id: teamId, name: `Placeholder team ${teamId}`, slug: `placeholder-team-${teamId}` },
  });
}

async function ensureAppForCredential(appId: string) {
  const metadata = Object.values(appStoreMetadata).find((app) => app.slug === appId);
  await prisma.app.upsert({
    where: { slug: appId },
    update: {},
    create: {
      slug: appId,
      dirName: metadata?.dirName ?? appId,
      enabled: true,
      categories: toJsonValue(metadata?.categories ?? []),
    },
  });
}

async function addWebhooksToDb(webhooks: InputWebhook[]) {
  if (!webhooks.length) return;
  await prisma.webhook.createMany({
    data: webhooks.map((webhook) => ({
      ...webhook,
      id: webhook.id ?? uuidv4(),
      eventTriggers: toJsonValue(webhook.eventTriggers),
    })),
  });
}

async function addPaymentToDb(payment: InputPayment[]) {
  if (!payment.length) return;
  await prisma.payment.createMany({
    data: payment.map((entry) => ({ ...entry, data: toJsonValue(entry.data) })),
  });
}

async function addWebhooks(webhooks: InputWebhook[]) {
  log.silly("TestData: Creating Webhooks", safeStringify(webhooks));

  await addWebhooksToDb(webhooks);
}

const pendingSelectedCalendars: Prisma.SelectedCalendarCreateManyInput[] = [];

export async function flushPendingSelectedCalendars() {
  if (!pendingSelectedCalendars.length) return;
  const rows = pendingSelectedCalendars.splice(0);
  const missingEventTypes = new Set(
    rows.map((row) => row.eventTypeId).filter((id): id is number => typeof id === "number")
  );
  for (const eventTypeId of Array.from(missingEventTypes)) {
    // D1 enforces the selected-calendar event type FK that prismock ignored.
    await prisma.eventType.upsert({
      where: { id: eventTypeId },
      update: {},
      create: {
        id: eventTypeId,
        title: `Placeholder event type ${eventTypeId}`,
        slug: `placeholder-event-type-${eventTypeId}`,
        length: 30,
      },
    });
  }
  await prisma.selectedCalendar.createMany({ data: rows });
}

export async function addUsersToDb(users: InputUser[]) {
  log.silly("TestData: Creating Users", JSON.stringify(users));
  for (const input of users) {
    const seed = input as unknown as Record<string, unknown>;
    const {
      schedules,
      credentials,
      teams,
      selectedCalendars,
      destinationCalendar,
      profiles,
      outOfOffice,
      secondaryEmails,
      ...userData
    } = seed;

    const uniqueSuffix = userData.id ?? uuidv4().slice(0, 8);
    const email = userData.email as string | undefined;
    if (email) {
      const existing = await prisma.user.findFirst({ where: { email }, select: { id: true } });
      if (existing) {
        const [local, domain] = email.split("@");
        userData.email = `${local}+${uniqueSuffix}@${domain ?? "example.com"}`;
      }
    }
    const username = userData.username as string | null | undefined;
    if (username && (userData.organizationId === null || userData.organizationId === undefined)) {
      const existing = await prisma.user.findFirst({
        where: { username, organizationId: null },
        select: { id: true },
      });
      if (existing) userData.username = `${username}-${uniqueSuffix}`;
    }
    const user = await prisma.user.create({
      data: userData as Prisma.UserUncheckedCreateInput,
    });

    const scheduleRows = Array.isArray(schedules)
      ? schedules
      : ((schedules as { createMany?: { data: unknown[] }; create?: unknown[] } | undefined)?.createMany
          ?.data ?? (schedules as { create?: unknown[] } | undefined)?.create);
    for (const schedule of scheduleRows ?? []) {
      const { availability, ...scheduleData } = schedule as {
        availability?: { createMany?: { data: unknown[] } } | unknown[];
        [key: string]: unknown;
      };
      const availabilityData = Array.isArray(availability)
        ? availability
        : (availability as { createMany?: { data: unknown[] } } | undefined)?.createMany?.data;
      if (scheduleData.id) {
        const existingSchedule = await prisma.schedule.findUnique({
          where: { id: scheduleData.id as number },
          select: { id: true },
        });
        if (existingSchedule) delete scheduleData.id;
      }
      const createdSchedule = await prisma.schedule.create({
        data: {
          ...(scheduleData as unknown as Prisma.ScheduleUncheckedCreateInput),
          userId: user.id,
        },
      });
      if (availabilityData?.length) {
        await prisma.availability.createMany({
          data: normalizeAvailability(availabilityData as Prisma.AvailabilityCreateManyInput[]).map(
            (entry) => ({
              ...entry,
              scheduleId: createdSchedule.id,
            })
          ),
        });
      }
    }

    const credentialRows = Array.isArray(credentials)
      ? credentials
      : (credentials as { createMany?: { data: unknown[] } } | undefined)?.createMany?.data;
    if (credentialRows?.length) {
      for (const credential of credentialRows as { appId?: string | null }[]) {
        if (credential.appId) await ensureAppForCredential(credential.appId);
      }
      await prisma.credential.createMany({
        data: (credentialRows as (Prisma.CredentialCreateManyInput & { app?: unknown })[]).map(
          ({ app, ...credential }) => ({
            ...(!isIntegrationMode ? { app } : {}),
            ...credential,
            key: toJsonValue(credential.key),
            userId: user.id,
          })
        ),
      });
    }

    const selectedCalendarRows = Array.isArray(selectedCalendars)
      ? selectedCalendars
      : (selectedCalendars as { createMany?: { data: unknown[] } } | undefined)?.createMany?.data;
    for (const calendar of (selectedCalendarRows as Prisma.SelectedCalendarCreateManyInput[]) ?? []) {
      const row = { ...calendar, userId: user.id };
      if (row.eventTypeId) {
        const eventType = await prisma.eventType.findUnique({
          where: { id: row.eventTypeId },
          select: { id: true },
        });
        if (!eventType) {
          pendingSelectedCalendars.push(row);
          continue;
        }
      }
      await prisma.selectedCalendar.create({ data: row });
    }

    const profileRows = Array.isArray(profiles)
      ? profiles
      : ((profiles as { create?: unknown[]; createMany?: { data: unknown[] } } | undefined)?.create ??
        (profiles as { createMany?: { data: unknown[] } } | undefined)?.createMany?.data);
    if (profileRows?.length) {
      await prisma.profile.createMany({
        data: (profileRows as Prisma.ProfileCreateManyInput[]).map((profile) => ({
          ...profile,
          userId: user.id,
        })),
      });
    }

    const destinationCalendarData =
      (destinationCalendar as { create?: Prisma.DestinationCalendarCreateInput } | undefined)?.create ??
      (destinationCalendar as Prisma.DestinationCalendarCreateInput | undefined);
    if (destinationCalendarData) {
      const {
        user: _dcUser,
        credential,
        ...calendarData
      } = destinationCalendarData as Prisma.DestinationCalendarCreateInput & { credentialId?: number | null };
      await prisma.destinationCalendar.create({
        data: {
          ...(calendarData as unknown as Prisma.DestinationCalendarUncheckedCreateInput),
          credentialId: credential?.connect?.id ?? calendarData.credentialId ?? null,
          userId: user.id,
        },
      });
    }

    const membershipRows = Array.isArray(teams)
      ? teams
      : (teams as { createMany?: { data: unknown[] } } | undefined)?.createMany?.data;
    for (const membershipInput of membershipRows ?? []) {
      const membership = membershipInput as {
        team?: { id: number; name: string; slug: string; parentId?: number; isPrivate?: boolean };
        teamId?: number;
        membership?: Partial<Membership>;
        role?: Membership["role"];
        accepted?: boolean;
      };
      let teamId = membership.teamId;
      if (membership.team) {
        const [addedTeam] = await addTeamsToDb([membership.team]);
        teamId = addedTeam.id;
      }
      if (!teamId) continue;
      await prisma.membership.create({
        data: {
          ...membership.membership,
          role: membership.membership?.role ?? membership.role ?? "MEMBER",
          accepted: membership.membership?.accepted ?? membership.accepted ?? true,
          teamId,
          userId: user.id,
        },
      });
    }

    if (outOfOffice) {
      log.debug("Creating OutOfOfficeEntry for user", user.id);
      for (const dateRange of (outOfOffice as { dateRanges: { start: string; end: string }[] }).dateRanges) {
        await prisma.outOfOfficeEntry.create({
          data: {
            uuid: uuidv4(),
            start: new Date(dateRange.start),
            end: new Date(dateRange.end),
            userId: user.id,
          },
        });
      }
    }

    if (secondaryEmails) {
      log.debug("Creating SecondaryEmail entries for user", user.id);
      for (const secondaryEmail of secondaryEmails as { email: string; emailVerified: Date | null }[]) {
        await prisma.secondaryEmail.create({
          data: {
            email: secondaryEmail.email,
            emailVerified: secondaryEmail.emailVerified,
            userId: user.id,
          },
        });
      }
    }
  }

  const allUsers = await prisma.user.findMany({
    orderBy: { id: "asc" },
    include: {
      credentials: true,
      teams: true,
      profiles: true,
      schedules: {
        include: {
          availability: true,
        },
      },
      destinationCalendar: true,
      secondaryEmails: true,
    },
  });

  log.silly(
    "Added users to Db",
    safeStringify({
      allUsers,
    })
  );

  return allUsers;
}

export async function addTeamsToDb(teams: NonNullable<InputUser["teams"]>[number]["team"][]) {
  log.silly("TestData: Creating Teams", JSON.stringify(teams));

  for (const team of teams) {
    const teamsWithParentId = {
      ...team,
      parentId: team.parentId,
    };
    await prisma.team.upsert({
      where: {
        id: teamsWithParentId.id,
      },
      update: {
        ...teamsWithParentId,
      },
      create: {
        ...teamsWithParentId,
      },
    });
  }

  const addedTeams = await prisma.team.findMany({
    where: {
      id: {
        in: teams.map((team) => team.id),
      },
    },
  });
  log.silly(
    "Added teams to Db",
    safeStringify({
      addedTeams,
    })
  );
  return addedTeams;
}

export async function addUsers(users: InputUser[]) {
  return await addUsersToDb(users);
}

async function addAppsToDb(apps: any[]) {
  log.silly("TestData: Creating Apps", JSON.stringify({ apps }));
  if (!isIntegrationMode) {
    if (apps.length) {
      await prisma.app.createMany({ data: apps });
    }
  } else
    for (const app of apps) {
      if (!app.slug) continue;
      const data = {
        dirName: app.dirName ?? app.slug,
        keys: app.keys === undefined ? undefined : toJsonValue(app.keys),
        categories: app.categories === undefined ? undefined : toJsonValue(app.categories),
        enabled: app.enabled ?? true,
      };
      await prisma.app.upsert({
        where: { slug: app.slug },
        update: data,
        create: { slug: app.slug, ...data },
      });
    }
  const allApps = await prisma.app.findMany();
  log.silly("TestData: Apps as in DB", JSON.stringify({ apps: allApps }));
}

async function addSelectedSlotsToDb(selectedSlots: InputSelectedSlot[]) {
  log.silly("TestData: Creating Selected Slots", JSON.stringify(selectedSlots));
  if (!selectedSlots.length) return;
  await prisma.selectedSlots.createMany({
    data: selectedSlots,
  });
  const allSelectedSlots = await prisma.selectedSlots.findMany();
  log.silly("TestData: Selected Slots as in DB", JSON.stringify({ selectedSlots: allSelectedSlots }));
}

export async function createBookingScenario(data: ScenarioData) {
  log.silly("TestData: Creating Scenario", JSON.stringify({ data }));
  if (data.apps) {
    await addAppsToDb(
      data.apps.map((app) => {
        // Enable the app by default
        return { enabled: true, ...app };
      })
    );
  }
  await addUsers(data.users);
  const eventTypes = await addEventTypes(data.eventTypes, data.users);
  await addHostsToDb(data.eventTypes);
  await flushPendingSelectedCalendars();

  data.bookings = data.bookings || [];
  // allowSuccessfulBookingCreation();
  await addBookings(data.bookings);
  // mockBusyCalendarTimes([]);
  await addWebhooks(data.webhooks || []);
  // addPaymentMock();
  await addPaymentToDb(data.payment || []);

  if (data.selectedSlots) {
    await addSelectedSlotsToDb(data.selectedSlots);
  }

  return {
    eventTypes,
  };
}

type TeamCreateReturnType = Team;

function assertNonNullableSlug<T extends { slug: string | null }>(
  org: T
): asserts org is T & { slug: string } {
  if (org.slug === null) {
    throw new Error("Slug cannot be null");
  }
}

export async function createOrganization(orgData: {
  name: string;
  slug: string;
  metadata?: z.infer<typeof teamMetadataSchema>;
  withTeam?: boolean;
}): Promise<TeamCreateReturnType & { slug: NonNullable<TeamCreateReturnType["slug"]>; children: any }> {
  const org = await prisma.team.create({
    data: {
      name: orgData.name,
      slug: orgData.slug,
      isOrganization: true,
      metadata: {
        ...(orgData.metadata || {}),
        isOrganization: true,
      },
    },
  });
  if (orgData.withTeam) {
    await prisma.team.create({
      data: {
        name: "Org Team",
        slug: "org-team",
        isOrganization: false,
        parent: {
          connect: {
            id: org.id,
          },
        },
      },
    });
  }
  assertNonNullableSlug(org);
  const team = await prisma.team.findUnique({ where: { id: org.id }, include: { children: true } });
  if (!team) {
    throw new Error(`Team with id ${org.id} not found`);
  }
  assertNonNullableSlug(team);
  return team;
}

export async function createCredentials(
  credentialData: {
    type: string;
    key: Prisma.InputJsonValue;
    id?: number;
    userId?: number | null;
    teamId?: number | null;
  }[]
) {
  for (const credential of credentialData as {
    appId?: string | null;
    userId?: number | null;
    teamId?: number | null;
  }[]) {
    if (credential.appId) await ensureAppForCredential(credential.appId);
    if (credential.userId) await ensureUserForForeignKey(credential.userId);
    if (credential.teamId) await ensureTeamForForeignKey(credential.teamId);
  }
  const credentials = await prisma.credential.createMany({
    data: credentialData.map((credential) => {
      const { id, type, key, userId, teamId, appId, app } = credential as typeof credential & {
        app?: unknown;
        appId?: string | null;
      };
      return {
        ...(!isIntegrationMode ? { app } : {}),
        id,
        type,
        key: toJsonValue(key),
        userId,
        teamId,
        appId,
      };
    }),
  });
  return credentials;
}

// async function addPaymentsToDb(payments: Prisma.PaymentCreateInput[]) {
//   await prismaMock.payment.createMany({
//     data: payments,
//   });
// }

/**
 * This fn indents to /ally compute day, month, year for the purpose of testing.
 * We are not using DayJS because that's actually being tested by this code.
 * - `dateIncrement` adds the increment to current day
 * - `monthIncrement` adds the increment to current month
 * - `yearIncrement` adds the increment to current year
 * - `fromDate` starts incrementing from this date (default: today)
 *  @deprecated Stop using this function as it is not timezone aware and can return wrong date depending on the time of the day and timezone. Instead
 *  use vi.setSystemTime to fix the date and time and then use hardcoded days instead of dynamic date calculation.
 */
export const getDate = (
  param: { dateIncrement?: number; monthIncrement?: number; yearIncrement?: number; fromDate?: Date } = {}
) => {
  let { dateIncrement, monthIncrement, yearIncrement, fromDate } = param;

  dateIncrement = dateIncrement || 0;
  monthIncrement = monthIncrement || 0;
  yearIncrement = yearIncrement || 0;
  fromDate = fromDate || new Date();

  fromDate.setDate(fromDate.getDate() + dateIncrement);
  fromDate.setMonth(fromDate.getMonth() + monthIncrement);
  fromDate.setFullYear(fromDate.getFullYear() + yearIncrement);

  let _date = fromDate.getDate();
  let year = fromDate.getFullYear();

  // Make it start with 1 to match with DayJS requiremet
  let _month = fromDate.getMonth() + 1;

  // If last day of the month(As _month is plus 1 already it is going to be the 0th day of next month which is the last day of current month)
  const lastDayOfMonth = new Date(year, _month, 0).getDate();
  const numberOfDaysForNextMonth = +_date - +lastDayOfMonth;
  if (numberOfDaysForNextMonth > 0) {
    _date = numberOfDaysForNextMonth;
    _month = _month + 1;
  }

  if (_month === 13) {
    _month = 1;
    year = year + 1;
  }

  const date = _date < 10 ? `0${_date}` : _date;
  const month = _month < 10 ? `0${_month}` : _month;

  return {
    date: String(date),
    month: String(month),
    year: String(year),
    dateString: `${year}-${month}-${date}`,
  };
};

const isWeekStart = (date: Date, weekStart: WeekDays) => {
  return date.getDay() === weekdayToWeekIndex(weekStart);
};

export const getNextMonthNotStartingOnWeekStart = (weekStart: WeekDays, from?: Date) => {
  const date = from ?? new Date();

  const incrementMonth = (date: Date) => {
    date.setMonth(date.getMonth() + 1);
  };

  // start searching from the 1st day of next month
  incrementMonth(date);
  date.setDate(1);

  while (isWeekStart(date, weekStart)) {
    incrementMonth(date);
  }

  return getDate({ fromDate: date });
};

export function getMockedCredential({
  metadataLookupKey,
  key,
}: {
  metadataLookupKey: string;
  key: {
    expiry_date?: number;
    token_type?: string;
    access_token?: string;
    refresh_token?: string;
    scope: string;
  };
}) {
  const app = appStoreMetadata[metadataLookupKey as keyof typeof appStoreMetadata];
  return {
    type: app.type,
    appId: app.slug,
    app: app,
    key: {
      expiry_date: Date.now() + 1000000,
      token_type: "Bearer",
      access_token: "ACCESS_TOKEN",
      refresh_token: "REFRESH_TOKEN",
      ...key,
    },
  };
}

export function getGoogleCalendarCredential() {
  return getMockedCredential({
    metadataLookupKey: "googlecalendar",
    key: {
      scope:
        "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly",
    },
  });
}

export function getGoogleMeetCredential() {
  return getMockedCredential({
    metadataLookupKey: "googlevideo",
    key: {
      scope: "",
    },
  });
}

export function getAppleCalendarCredential() {
  return getMockedCredential({
    metadataLookupKey: "applecalendar",
    key: {
      scope:
        "https://www.applecalendar.example/auth/calendar.events https://www.applecalendar.example/auth/calendar.readonly",
    },
  });
}

export function getZoomAppCredential() {
  return getMockedCredential({
    metadataLookupKey: "zoomvideo",
    key: {
      scope: "meeting:write",
    },
  });
}

export function getStripeAppCredential() {
  return getMockedCredential({
    metadataLookupKey: "stripepayment",
    key: {
      scope: "read_write",
    },
  });
}

export const TestData = {
  selectedCalendars: {
    google: {
      integration: "google_calendar",
      externalId: "john@example.com",
    },
    office365: {
      integration: "office365_calendar",
      externalId: "john@example.com",
    },
  },
  credentials: {
    google: getGoogleCalendarCredential(),
  },
  schedules: {
    IstWorkHours: {
      id: 1,
      name: "9:30AM to 6PM in India - 4:00AM to 12:30PM in GMT",
      availability: [
        {
          // userId: null,
          // eventTypeId: null,
          days: [0, 1, 2, 3, 4, 5, 6],
          startTime: new Date("1970-01-01T09:30:00.000Z"),
          endTime: new Date("1970-01-01T18:00:00.000Z"),
          date: null,
        },
      ],
      timeZone: Timezones["+5:30"],
    },
    /**
     * Has an overlap with IstEveningShift from 5PM to 6PM IST(11:30AM to 12:30PM GMT)
     */
    IstMorningShift: {
      name: "9:30AM to 6PM in India - 4:00AM to 12:30PM in GMT",
      availability: [
        {
          // userId: null,
          // eventTypeId: null,
          days: [0, 1, 2, 3, 4, 5, 6],
          startTime: new Date("1970-01-01T09:30:00.000Z"),
          endTime: new Date("1970-01-01T18:00:00.000Z"),
          date: null,
        },
      ],
      timeZone: Timezones["+5:30"],
    },
    /**
     * Has an overlap with IstMorningShift and IstEveningShift
     */
    IstMidShift: {
      name: "12:30AM to 8PM in India - 7:00AM to 14:30PM in GMT",
      availability: [
        {
          // userId: null,
          // eventTypeId: null,
          days: [0, 1, 2, 3, 4, 5, 6],
          startTime: new Date("1970-01-01T12:30:00.000Z"),
          endTime: new Date("1970-01-01T20:00:00.000Z"),
          date: null,
        },
      ],
      timeZone: Timezones["+5:30"],
    },
    /**
     * Has an overlap with IstMorningShift from 5PM to 6PM IST(11:30AM to 12:30PM GMT)
     */
    IstEveningShift: {
      name: "5:00PM to 10PM in India - 11:30AM to 16:30PM in GMT",
      availability: [
        {
          // userId: null,
          // eventTypeId: null,
          days: [0, 1, 2, 3, 4, 5, 6],
          startTime: new Date("1970-01-01T17:00:00.000Z"),
          endTime: new Date("1970-01-01T22:00:00.000Z"),
          date: null,
        },
      ],
      timeZone: Timezones["+5:30"],
    },
    EmptyAvailability: {
      name: "Empty Availability",
      availability: [],
      timeZone: Timezones["+5:30"],
    },
    IstNotAvailableForFullMonth: (monthYear: string) => {
      const [year, month] = monthYear.split("-").map(Number); // Expecting format 'YYYY-MM'
      const startOfMonth = new Date(year, month - 1, 1);
      const endOfMonth = new Date(year, month, 0);
      const availability: {
        days: number[];
        startTime: Date;
        endTime: Date;
        date: string | null;
      }[] = [
        {
          days: [0, 1, 2, 3, 4, 5, 6],
          startTime: new Date("1970-01-01T18:00:00.000Z"),
          endTime: new Date("1970-01-01T22:00:00.000Z"),
          date: null,
        },
      ];
      // Generate unavailable dates for the entire month
      const currentDate = new Date(startOfMonth);
      while (currentDate <= endOfMonth) {
        const dateString = currentDate.toISOString().split("T")[0];
        availability.push({
          days: [],
          startTime: new Date(`${dateString}T00:00:00.000Z`),
          endTime: new Date(`${dateString}T00:00:00.000Z`),
          date: dateString,
        });
        currentDate.setDate(currentDate.getDate() + 1);
      }

      return {
        name: "Unavailable for the entire month, then available from 18:00AM to 22:00 IST",
        availability,
        timeZone: Timezones["+5:30"],
      };
    },
    IstWorkHoursWithFirstTwoWeeksUnavailable: (dateString: string) => {
      const date = new Date(dateString);
      const availability: {
        days: number[];
        startTime: Date;
        endTime: Date;
        date: string | null;
      }[] = [
        {
          days: [0, 1, 2, 3, 4, 5, 6],
          startTime: new Date("1970-01-01T18:00:00.000Z"),
          endTime: new Date("1970-01-01T22:00:00.000Z"),
          date: null,
        },
      ];

      // Generate dateoverride for each day in the first two weeks
      for (let i = 0; i < 15; i++) {
        const dateString = date.toISOString().split("T")[0];
        availability.push({
          days: [],
          startTime: new Date(`${dateString}T00:00:00.000Z`),
          endTime: new Date(`${dateString}T00:00:00.000Z`),
          date: dateString,
        });
        date.setDate(date.getDate() + 1);
      }

      return {
        name: "Unavailable for the first two weeks, then available from 18:00 to 22:00 IST",
        availability,
        timeZone: Timezones["+5:30"],
      };
    },
    IstWorkHoursWithDateOverride: (dateString: string) => ({
      name: "9:30AM to 6PM in India - 4:00AM to 12:30PM in GMT but with a Date Override for 2PM to 6PM IST(in GST time it is 8:30AM to 12:30PM)",
      availability: [
        {
          days: [0, 1, 2, 3, 4, 5, 6],
          startTime: new Date("1970-01-01T09:30:00.000Z"),
          endTime: new Date("1970-01-01T18:00:00.000Z"),
          date: null,
        },
        {
          days: [0, 1, 2, 3, 4, 5, 6],
          startTime: new Date(`1970-01-01T14:00:00.000Z`),
          endTime: new Date(`1970-01-01T18:00:00.000Z`),
          date: dateString,
        },
      ],
      timeZone: Timezones["+5:30"],
    }),
    IstWorkHoursNoWeekends: {
      id: 1,
      name: "9:30AM to 6PM in India - 4:00AM to 12:30PM in GMT",
      availability: [
        {
          // userId: null,
          // eventTypeId: null,
          days: [/*0*/ 1, 2, 3, 4, 5 /*6*/],
          startTime: new Date("1970-01-01T09:30:00.000Z"),
          endTime: new Date("1970-01-01T18:00:00.000Z"),
          date: null,
        },
      ],
      timeZone: Timezones["+5:30"],
    },
  },
  users: {
    example: {
      name: "Example",
      email: "example@example.com",
      username: "example.username",
      defaultScheduleId: 1,
      timeZone: Timezones["+5:30"],
    },
  },
  apps: {
    "google-calendar": {
      ...appStoreMetadata.googlecalendar,
      keys: {
        expiry_date: Infinity,
        client_id: "client_id",
        client_secret: "client_secret",
        redirect_uris: ["http://localhost:3000/auth/callback"],
      },
    },
    "office365-calendar": {
      ...appStoreMetadata.office365calendar,
      keys: {
        expiry_date: Infinity,
        client_id: "client_id",
        client_secret: "client_secret",
      },
    },
    "google-meet": {
      ...appStoreMetadata.googlevideo,
      keys: {
        expiry_date: Infinity,
        client_id: "client_id",
        client_secret: "client_secret",
        redirect_uris: ["http://localhost:3000/auth/callback"],
      },
    },
    "daily-video": {
      ...appStoreMetadata.dailyvideo,
      keys: {
        expiry_date: Infinity,
        api_key: "",
        scale_plan: "false",
        client_id: "client_id",
        client_secret: "client_secret",
        redirect_uris: ["http://localhost:3000/auth/callback"],
      },
    },
    zoomvideo: {
      ...appStoreMetadata.zoomvideo,
      keys: {
        expiry_date: Infinity,
        api_key: "",
        scale_plan: "false",
        client_id: "client_id",
        client_secret: "client_secret",
        redirect_uris: ["http://localhost:3000/auth/callback"],
      },
    },
    "stripe-payment": {
      ...appStoreMetadata.stripepayment,
      keys: {
        expiry_date: Infinity,
        api_key: "",
        scale_plan: "false",
        client_id: "client_id",
        client_secret: "client_secret",
        redirect_uris: ["http://localhost:3000/auth/callback"],
      },
    },
  },
};

export class MockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MockError";
  }
}

export function getOrganizer({
  name,
  email,
  id,
  schedules,
  credentials,
  selectedCalendars,
  destinationCalendar,
  defaultScheduleId,
  weekStart = "Sunday",
  teams,
  organizationId,
  metadata,
  smsLockState,
  completedOnboarding,
  username,
  locked,
  emailVerified,
  requiresBookerEmailVerification,
  secondaryEmails,
}: {
  name: string;
  email: string;
  id: number;
  organizationId?: number | null;
  schedules: InputUser["schedules"];
  credentials?: InputCredential[];
  selectedCalendars?: InputSelectedCalendar[];
  defaultScheduleId?: number | null;
  destinationCalendar?: Prisma.DestinationCalendarCreateInput;
  weekStart?: WeekDays;
  teams?: InputUser["teams"];
  metadata?: userMetadataType;
  smsLockState?: SMSLockState;
  completedOnboarding?: boolean;
  username?: string;
  locked?: boolean;
  emailVerified?: Date | null;
  requiresBookerEmailVerification?: boolean;
  secondaryEmails?: { email: string; emailVerified: Date | null }[];
}) {
  username = username ?? TestData.users.example.username;
  return {
    ...TestData.users.example,
    name,
    username,
    email,
    id,
    schedules,
    credentials,
    selectedCalendars,
    destinationCalendar,
    defaultScheduleId,
    weekStart,
    teams,
    organizationId,
    profiles: [],
    metadata,
    smsLockState,
    completedOnboarding,
    locked,
    emailVerified,
    requiresBookerEmailVerification,
    secondaryEmails,
  };
}

export function getScenarioData(
  {
    /**
     * organizer has no special meaning. It is a regular user. It is supposed to be deprecated along with `usersApartFromOrganizer` and we should introduce a new `users` field instead
     */
    organizer,
    eventTypes,
    usersApartFromOrganizer = [],
    apps = [],
    users: _users,
    webhooks,
    bookings,
    payment,
  }: {
    organizer?: ReturnType<typeof getOrganizer>;
    eventTypes: ScenarioData["eventTypes"];
    apps?: ScenarioData["apps"];
    users?: ScenarioData["users"];
    usersApartFromOrganizer?: ScenarioData["users"];
    webhooks?: ScenarioData["webhooks"];
    bookings?: ScenarioData["bookings"];
    payment?: ScenarioData["payment"];
  },
  org?: { id: number | null; profileUsername?: string } | undefined | null
) {
  if (_users && (usersApartFromOrganizer.length || organizer)) {
    throw new Error("When users are provided, usersApartFromOrganizer and organizer should not be provided");
  }
  const users = _users ? _users : organizer ? [organizer, ...usersApartFromOrganizer] : [];
  if (!users.length) {
    throw new Error("No users are specified in any way");
  }
  if (org) {
    const orgId = org.id;
    if (!orgId) {
      throw new Error("If org is specified org.id is required");
    }

    users.forEach((user) => {
      const profileUsername = org.profileUsername ?? user.username ?? "";
      user.profiles = [
        {
          organizationId: orgId,
          username: profileUsername,
          uid: uuidv4(),
        },
      ];
    });
  }
  eventTypes.forEach((eventType) => {
    if (
      eventType.users?.filter((eventTypeUser) => {
        return !users.find((userToCreate) => userToCreate.id === eventTypeUser.id);
      }).length
    ) {
      throw new Error(`EventType ${eventType.id} has users that are not present in ScenarioData["users"]`);
    }
  });
  return {
    eventTypes: eventTypes.map((eventType, index) => {
      return {
        ...eventType,
        teamId: eventType.teamId || null,
        team: {
          id: eventType.teamId ?? eventType.team?.id,
          parentId: org ? org.id : null,
          bookingLimits: eventType?.team?.bookingLimits,
          includeManagedEventsInLimits: eventType?.team?.includeManagedEventsInLimits,
        },
        title: `Test Event Type - ${index + 1}`,
        description: `It's a test event type - ${index + 1}`,
      };
    }),
    users: users.map((user) => {
      const newUser = {
        ...user,
        organizationId: user.organizationId ?? null,
      };
      return newUser;
    }),
    apps: [...apps],
    webhooks,
    bookings: bookings || [],
    payment,
  } satisfies ScenarioData;
}

export async function enableEmailFeature() {
  const data = {
    slug: "emails",
    enabled: false,
    type: "KILL_SWITCH" as const,
  };
  const { prisma } = await import("@calcom/prisma");
  if (isIntegrationMode) {
    await prisma.feature.upsert({
      where: { slug: data.slug },
      update: { enabled: data.enabled, type: data.type },
      create: data,
    });
    return;
  }
  await prisma.feature.create({ data });
}

export function mockNoTranslations() {
  log.silly("Mocking i18n.getTranslation to return identity function");
  i18nMock.getTranslation.mockImplementation(() => {
    return new Promise((resolve) => {
      const identityFn = ((key: string) => key) as TFunction<string, undefined>;
      resolve(identityFn);
    });
  });
}

export enum BookingLocations {
  CalVideo = "integrations:daily",
  ZoomVideo = "integrations:zoom",
  GoogleMeet = "integrations:google:meet",
}

export type CalendarServiceMethodMockCallBase = {
  calendarServiceConstructorArgs: {
    credential: CredentialPayload;
  };
};

type CreateEventMethodMockCall = CalendarServiceMethodMockCallBase & {
  args: {
    calEvent: CalendarEvent;
    credentialId: number;
    externalCalendarId?: string;
  };
};

type UpdateEventMethodMockCall = CalendarServiceMethodMockCallBase & {
  args: {
    uid: string;
    event: CalendarEvent;
    externalCalendarId?: string | null;
  };
};

type DeleteEventMethodMockCall = CalendarServiceMethodMockCallBase & {
  args: {
    uid: string;
    event: CalendarEvent;
    externalCalendarId?: string | null;
  };
};

type GetAvailabilityMethodMockCall = CalendarServiceMethodMockCallBase & {
  args: {
    dateFrom: string;
    dateTo: string;
    selectedCalendars: IntegrationCalendar[];
    mode: "slots" | "overlay" | "booking";
  };
};

export type CalendarServiceMethodMock = {
  createEventCalls: CreateEventMethodMockCall[];
  updateEventCalls: UpdateEventMethodMockCall[];
  deleteEventCalls: DeleteEventMethodMockCall[];
  getAvailabilityCalls: GetAvailabilityMethodMockCall[];
};

/**
 * @param metadataLookupKey
 * @param calendarData Specify uids and other data to be faked to be returned by createEvent and updateEvent
 */
export async function mockCalendar(
  metadataLookupKey: keyof typeof appStoreMetadata,
  calendarData?: {
    create?: {
      id?: string;
      uid?: string;
      iCalUID?: string;
      appSpecificData?: {
        googleCalendar?: {
          hangoutLink?: string;
        };
        office365Calendar?: {
          url?: string;
        };
      };
    };
    update?: {
      id?: string;
      uid: string;
      iCalUID?: string;
      appSpecificData?: {
        googleCalendar?: {
          hangoutLink?: string;
        };
        office365Calendar?: {
          url?: string;
        };
      };
    };
    busySlots?: { start: `${string}Z`; end: `${string}Z` }[];
    creationCrash?: boolean;
    updationCrash?: boolean;
    getAvailabilityCrash?: boolean;
  }
): Promise<CalendarServiceMethodMock> {
  const appStoreLookupKey = metadataLookupKey;
  const normalizedCalendarData = calendarData || {
    create: {
      uid: "MOCK_ID",
    },
    update: {
      uid: "UPDATED_MOCK_ID",
    },
  };
  log.silly(`Mocking ${appStoreLookupKey} on appStoreMock`);

  const createEventCalls: CreateEventMethodMockCall[] = [];
  const updateEventCalls: UpdateEventMethodMockCall[] = [];
  const deleteEventCalls: DeleteEventMethodMockCall[] = [];
  const getAvailabilityCalls: GetAvailabilityMethodMockCall[] = [];
  const app = appStoreMetadata[metadataLookupKey as keyof typeof appStoreMetadata];

  // Use the shared mock map directly instead of dynamically importing calendar.services.generated.
  // This avoids loading real calendar service modules (which can trigger async fetch calls that
  // cause "Closing rpc while fetch was pending" errors when the test worker shuts down).
  const mockCalendarServiceConstructor = getOrCreateCalendarServiceMock(appStoreLookupKey);
  mockCalendarServiceConstructor.mockImplementation(function MockCalendarService(credential) {
    return {
      createEvent: async (...rest: Parameters<Calendar["createEvent"]>): Promise<NewCalendarEventType> => {
        if (calendarData?.creationCrash) {
          throw new Error("MockCalendarService.createEvent fake error");
        }
        const [calEvent, credentialId, externalCalendarId] = rest;
        log.debug("mockCalendar.createEvent", JSON.stringify({ calEvent, credentialId, externalCalendarId }));
        createEventCalls.push({
          args: {
            calEvent,
            credentialId,
            externalCalendarId,
          },
          calendarServiceConstructorArgs: {
            credential,
          },
        });
        const isGoogleMeetLocation = calEvent?.location === BookingLocations.GoogleMeet;
        if (app.type === "google_calendar") {
          return Promise.resolve({
            type: app.type,
            additionalInfo: {
              hangoutLink:
                normalizedCalendarData.create?.appSpecificData?.googleCalendar?.hangoutLink ||
                "https://GOOGLE_MEET_URL_IN_CALENDAR_EVENT",
            },
            hangoutLink:
              normalizedCalendarData.create?.appSpecificData?.googleCalendar?.hangoutLink ||
              "https://GOOGLE_MEET_URL_IN_CALENDAR_EVENT",
            uid: normalizedCalendarData.create?.uid || "GOOGLE_CALENDAR_EVENT_ID",
            id: normalizedCalendarData.create?.id || "GOOGLE_CALENDAR_EVENT_ID",
            iCalUID: normalizedCalendarData.create?.iCalUID || calEvent.iCalUID || "GOOGLE_CALENDAR_EVENT_ID",
            password: "MOCK_PASSWORD",
            url:
              normalizedCalendarData.create?.appSpecificData?.googleCalendar?.hangoutLink ||
              "https://GOOGLE_MEET_URL_IN_CALENDAR_EVENT",
          });
        } else if (app.type === "office365_calendar") {
          return Promise.resolve({
            type: app.type,
            additionalInfo: {},
            uid: normalizedCalendarData.create?.uid || "OFFICE_365_CALENDAR_EVENT_ID",
            id: normalizedCalendarData.create?.id || "OFFICE_365_CALENDAR_EVENT_ID",
            iCalUID:
              normalizedCalendarData.create?.iCalUID || calEvent.iCalUID || "OFFICE_365_CALENDAR_EVENT_ID",
            password: "MOCK_PASSWORD",
            url:
              normalizedCalendarData.create?.appSpecificData?.office365Calendar?.url || "https://UNUSED_URL",
          });
        } else {
          return Promise.resolve({
            type: app.type,
            additionalInfo: {},
            uid: "PROBABLY_UNUSED_UID",
            hangoutLink:
              (isGoogleMeetLocation
                ? normalizedCalendarData.create?.appSpecificData?.googleCalendar?.hangoutLink
                : null) || "https://UNUSED_URL",
            // A Calendar is always expected to return an id.
            id: normalizedCalendarData.create?.id || "FALLBACK_MOCK_CALENDAR_EVENT_ID",
            iCalUID: normalizedCalendarData.create?.iCalUID,
            // Password and URL seems useless for CalendarService, plan to remove them if that's the case
            password: "MOCK_PASSWORD",
            url: "https://UNUSED_URL",
          });
        }
      },
      updateEvent: async (...rest: Parameters<Calendar["updateEvent"]>): Promise<NewCalendarEventType> => {
        if (calendarData?.updationCrash) {
          throw new Error("MockCalendarService.updateEvent fake error");
        }
        const [uid, event, externalCalendarId] = rest;
        log.silly("mockCalendar.updateEvent", JSON.stringify({ uid, event, externalCalendarId }));
        updateEventCalls.push({
          args: {
            uid,
            event,
            externalCalendarId,
          },
          calendarServiceConstructorArgs: {
            credential,
          },
        });
        const isGoogleMeetLocation = event.location === BookingLocations.GoogleMeet;
        return Promise.resolve({
          type: app.type,
          additionalInfo: {},
          uid: "PROBABLY_UNUSED_UID",
          iCalUID: normalizedCalendarData.update?.iCalUID,
          id: normalizedCalendarData.update?.uid || "FALLBACK_MOCK_ID",
          // Password and URL seems useless for CalendarService, plan to remove them if that's the case
          password: "MOCK_PASSWORD",
          url: "https://UNUSED_URL",
          location: isGoogleMeetLocation ? "https://UNUSED_URL" : undefined,
          hangoutLink:
            (isGoogleMeetLocation
              ? normalizedCalendarData.update?.appSpecificData?.googleCalendar?.hangoutLink
              : null) || "https://UNUSED_URL",
          conferenceData: isGoogleMeetLocation ? event.conferenceData : undefined,
        });
      },
      deleteEvent: async (...rest: Parameters<Calendar["deleteEvent"]>) => {
        log.silly("mockCalendar.deleteEvent", JSON.stringify({ rest }));
        deleteEventCalls.push({
          args: {
            uid: rest[0],
            event: rest[1],
            externalCalendarId: rest[2],
          },
          calendarServiceConstructorArgs: {
            credential,
          },
        });
      },
      getAvailability: async (params: {
        dateFrom: string;
        dateTo: string;
        selectedCalendars: IntegrationCalendar[];
        mode: "slots" | "overlay" | "booking";
        fallbackToPrimary?: boolean;
      }): Promise<EventBusyDate[]> => {
        const { dateFrom, dateTo, selectedCalendars, mode } = params;
        if (calendarData?.getAvailabilityCrash) {
          throw new Error("MockCalendarService.getAvailability fake error");
        }
        getAvailabilityCalls.push({
          args: {
            dateFrom,
            dateTo,
            selectedCalendars,
            mode,
          },
          calendarServiceConstructorArgs: {
            credential,
          },
        });
        return new Promise((resolve) => {
          resolve(calendarData?.busySlots || []);
        });
      },
      listCalendars: async (): Promise<IntegrationCalendar[]> => Promise.resolve([]),
    } as Calendar;
  });

  return {
    createEventCalls,
    updateEventCalls,
    deleteEventCalls,
    getAvailabilityCalls,
  };
}

export async function mockCalendarToHaveNoBusySlots(
  metadataLookupKey: keyof typeof appStoreMetadata,
  calendarData?: Parameters<typeof mockCalendar>[1]
) {
  calendarData = calendarData || {
    create: {
      uid: "MOCK_ID",
    },
    update: {
      uid: "UPDATED_MOCK_ID",
    },
  };
  return await mockCalendar(metadataLookupKey, { ...calendarData, busySlots: [] });
}

export async function mockCalendarToCrashOnGetAvailability(metadataLookupKey: keyof typeof appStoreMetadata) {
  return await mockCalendar(metadataLookupKey, { getAvailabilityCrash: true });
}

export async function mockCalendarToCrashOnCreateEvent(metadataLookupKey: keyof typeof appStoreMetadata) {
  return await mockCalendar(metadataLookupKey, { creationCrash: true });
}

export async function mockCalendarToCrashOnUpdateEvent(metadataLookupKey: keyof typeof appStoreMetadata) {
  return await mockCalendar(metadataLookupKey, { updationCrash: true });
}

export function mockVideoApp({
  metadataLookupKey,
  appStoreLookupKey,
  videoMeetingData,
  creationCrash,
  updationCrash,
}: {
  metadataLookupKey: string;
  appStoreLookupKey?: string;
  videoMeetingData?: {
    password: string;
    id: string;
    url: string;
  };
  creationCrash?: boolean;
  updationCrash?: boolean;
}) {
  appStoreLookupKey = appStoreLookupKey || metadataLookupKey;
  videoMeetingData = videoMeetingData || {
    id: "MOCK_ID",
    password: "MOCK_PASS",
    url: `http://mock-${metadataLookupKey}.example.com`,
  };
  log.silly("mockVideoApp", JSON.stringify({ metadataLookupKey, appStoreLookupKey }));

  const createMeetingCalls: any[] = [];

  const updateMeetingCalls: any[] = [];

  const deleteMeetingCalls: any[] = [];

  const mockVideoAdapter = (credential: unknown) => {
    return {
      createMeeting: (...rest: Parameters<NonNullableVideoApiAdapter["createMeeting"]>) => {
        if (creationCrash) {
          throw new Error("MockVideoApiAdapter.createMeeting fake error");
        }
        createMeetingCalls.push({
          credential,
          args: rest,
        });

        return Promise.resolve({
          type: appStoreMetadata[metadataLookupKey as keyof typeof appStoreMetadata].type,
          ...videoMeetingData,
        });
      },
      updateMeeting: async (...rest: Parameters<NonNullableVideoApiAdapter["updateMeeting"]>) => {
        if (updationCrash) {
          throw new Error("MockVideoApiAdapter.updateMeeting fake error");
        }
        const [bookingRef, calEvent] = rest;
        updateMeetingCalls.push({
          credential,
          args: rest,
        });
        if (!bookingRef.type) {
          throw new Error("bookingRef.type is not defined");
        }
        if (!calEvent.organizer) {
          throw new Error("calEvent.organizer is not defined");
        }
        log.silly("MockVideoApiAdapter.updateMeeting", JSON.stringify({ bookingRef, calEvent }));
        return Promise.resolve({
          type: appStoreMetadata[metadataLookupKey as keyof typeof appStoreMetadata].type,
          ...videoMeetingData,
        });
      },
      deleteMeeting: async (...rest: Parameters<NonNullableVideoApiAdapter["deleteMeeting"]>) => {
        log.silly("MockVideoApiAdapter.deleteMeeting", JSON.stringify(rest));
        deleteMeetingCalls.push({
          credential,
          args: rest,
        });
      },
    };
  };

  mockVideoAdapterRegistry[appStoreLookupKey] = Promise.resolve({
    default: mockVideoAdapter,
  });

  return {
    createMeetingCalls,
    updateMeetingCalls,
    deleteMeetingCalls,
  };
}

export function mockSuccessfulVideoMeetingCreation({
  metadataLookupKey,
  appStoreLookupKey,
  videoMeetingData,
}: {
  metadataLookupKey: string;
  appStoreLookupKey?: string;
  videoMeetingData?: {
    password: string;
    id: string;
    url: string;
  };
}) {
  return mockVideoApp({
    metadataLookupKey,
    appStoreLookupKey,
    videoMeetingData,
  });
}

export function mockVideoAppToCrashOnCreateMeeting({
  metadataLookupKey,
  appStoreLookupKey,
}: {
  metadataLookupKey: string;
  appStoreLookupKey?: string;
}) {
  return mockVideoApp({
    metadataLookupKey,
    appStoreLookupKey,
    creationCrash: true,
  });
}

export function mockPaymentApp({
  metadataLookupKey,
  appStoreLookupKey,
}: {
  metadataLookupKey: string;
  appStoreLookupKey?: string;
}) {
  const _appStoreLookupKey = appStoreLookupKey || metadataLookupKey;
  const { paymentUid, externalId } = getMockPaymentService();

  return {
    paymentUid,
    externalId,
  };
}

export function mockErrorOnVideoMeetingCreation({
  metadataLookupKey,
  appStoreLookupKey,
}: {
  metadataLookupKey: string;
  appStoreLookupKey?: string;
}) {
  appStoreLookupKey = appStoreLookupKey || metadataLookupKey;

  const mockErrorAdapter = () => ({
    createMeeting: () => {
      throw new MockError("Error creating Video meeting");
    },
  });

  mockVideoAdapterRegistry[appStoreLookupKey] = Promise.resolve({
    default: mockErrorAdapter,
  });
}

export function mockCrmApp(
  metadataLookupKey: string,
  crmData?: {
    createContacts?: {
      id: string;
      email: string;
    }[];
    getContacts?: {
      id: string;
      email: string;
      ownerEmail: string;
    }[];
  }
) {
  let contactsCreated: {
    id: string;
    email: string;
  }[] = [];
  let contactsQueried: {
    id: string;
    email: string;
    ownerEmail: string;
  }[] = [];
  const eventsCreated: boolean[] = [];

  // Mock the CrmServiceMap directly instead of using the old app-store index approach
  vi.doMock("@calcom/app-store/crm.apps.generated", async (importOriginal) => {
    const original = await importOriginal<typeof import("@calcom/app-store/crm.apps.generated")>();

    class MockCrmService {
      constructor() {
        log.debug("Create CrmService");
      }

      createContact() {
        if (crmData?.createContacts) {
          contactsCreated = crmData.createContacts;
          return Promise.resolve(crmData?.createContacts);
        }
        return Promise.resolve([]);
      }

      getContacts(email: string) {
        if (crmData?.getContacts) {
          contactsQueried = crmData?.getContacts;
          const contactsOfEmail = contactsQueried.filter((contact) => contact.email === email);
          return Promise.resolve(contactsOfEmail);
        }
        return Promise.resolve([]);
      }

      createEvent() {
        eventsCreated.push(true);
        return Promise.resolve({});
      }
    }

    return {
      ...original,
      CrmServiceMap: {
        ...original.CrmServiceMap,
        [metadataLookupKey]: Promise.resolve({
          default: MockCrmService,
        }),
      },
    };
  });

  return {
    contactsCreated,
    contactsQueried,
    eventsCreated,
  };
}

export function getBooker({
  name,
  email,
  attendeePhoneNumber,
}: {
  name: string;
  email: string;
  attendeePhoneNumber?: string;
}) {
  return {
    name,
    email,
    attendeePhoneNumber,
  };
}

export function getExpectedCalEventForBookingRequest({
  bookingRequest,
  eventType,
}: {
  bookingRequest: ReturnType<typeof getMockRequestDataForBooking>;

  eventType: any;
}) {
  return {
    // keep adding more fields as needed, so that they can be verified in all scenarios
    type: eventType.slug,
    // Not sure why, but milliseconds are missing in cal Event.
    startTime: bookingRequest.start.replace(".000Z", "Z"),
    endTime: bookingRequest.end.replace(".000Z", "Z"),
  };
}

export function getMockBookingReference(
  bookingReference: Partial<BookingReference> & Pick<BookingReference, "type" | "uid" | "credentialId">
) {
  let credentialId = bookingReference.credentialId;
  if (bookingReference.type === appStoreMetadata.dailyvideo.type) {
    // Right now we seems to be storing credentialId for `dailyvideo` in BookingReference as null. Another possible value is 0 in there.
    credentialId = null;
    log.debug("Ensuring null credentialId for dailyvideo");
  }
  return {
    ...bookingReference,
    credentialId,
  };
}

export function getMockBookingAttendee(
  attendee: Omit<Attendee, "bookingId" | "phoneNumber" | "email" | "noShow"> & {
    bookingSeat?: AttendeeBookingSeatInput;
    phoneNumber?: string | null;
    email: string;
    noShow?: boolean;
  }
) {
  return {
    id: attendee.id,
    timeZone: attendee.timeZone,
    name: attendee.name,
    email: attendee.email,
    locale: attendee.locale,
    bookingSeat: attendee.bookingSeat || null,
    phoneNumber: attendee.phoneNumber ?? undefined,
    noShow: attendee.noShow ?? false,
  };
}

const getMockAppStatus = ({
  slug,
  failures,
  success,
  overrideName,
}: {
  slug: string;
  failures: number;
  success: number;
  overrideName?: string;
}) => {
  const foundEntry = Object.entries(appStoreMetadata).find(([, app]) => {
    return app.slug === slug;
  });
  if (!foundEntry) {
    throw new Error("App not found for the slug");
  }
  const foundApp = foundEntry[1];
  return {
    appName: overrideName ?? foundApp.name,
    type: foundApp.type,
    failures,
    success,
    errors: [],
  };
};
export const getMockFailingAppStatus = ({ slug }: { slug: string }) => {
  return getMockAppStatus({ slug, failures: 1, success: 0 });
};

export const getMockPassingAppStatus = ({ slug, overrideName }: { slug: string; overrideName?: string }) => {
  return getMockAppStatus({ slug, overrideName, failures: 0, success: 1 });
};

export const replaceDates = (dates: string[], replacement: Record<string, string>) => {
  return dates.map((date) => {
    return date.replace(/(.*)T/, (_, group1) => `${replacement[group1]}T`);
  });
};

export const getDefaultBookingFields = ({
  emailField,
  bookingFields = [],
}: {
  emailField?: Fields[number];
  bookingFields: Fields;
}) => {
  return [
    {
      name: "name",
      type: "name",
      sources: [{ id: "default", type: "default", label: "Default" }],
      editable: "system",
      required: true,
      defaultLabel: "your_name",
    },
    emailField
      ? emailField
      : {
          name: "email",
          type: "email",
          label: "",
          hidden: false,
          sources: [{ id: "default", type: "default", label: "Default" }],
          editable: "system-but-optional",
          required: true,
          placeholder: "",
          defaultLabel: "email_address",
        },
    {
      name: "location",
      type: "radioInput",
      sources: [{ id: "default", type: "default", label: "Default" }],
      editable: "system",
      required: false,
      defaultLabel: "location",
      getOptionsAt: "locations",
      optionsInputs: {
        phone: { type: "phone", required: true, placeholder: "" },
        attendeeInPerson: { type: "address", required: true, placeholder: "" },
      },
      hideWhenJustOneOption: true,
    },
    {
      name: "title",
      type: "text",
      hidden: true,
      sources: [{ id: "default", type: "default", label: "Default" }],
      editable: "system-but-optional",
      required: true,
      defaultLabel: "what_is_this_meeting_about",
      defaultPlaceholder: "",
    },
    {
      name: "notes",
      type: "textarea",
      sources: [{ id: "default", type: "default", label: "Default" }],
      editable: "system-but-optional",
      required: false,
      defaultLabel: "additional_notes",
      defaultPlaceholder: "share_additional_notes",
    },
    {
      name: "guests",
      type: "multiemail",
      hidden: false,
      sources: [{ id: "default", type: "default", label: "Default" }],
      editable: "system-but-optional",
      required: false,
      defaultLabel: "additional_guests",
      defaultPlaceholder: "email",
    },
    {
      name: "rescheduleReason",
      type: "textarea",
      views: [{ id: "reschedule", label: "Reschedule View" }],
      sources: [{ id: "default", type: "default", label: "Default" }],
      editable: "system-but-optional",
      required: false,
      defaultLabel: "reason_for_reschedule",
      defaultPlaceholder: "reschedule_placeholder",
    },
    ...bookingFields,
  ] as Fields;
};

export const createDelegationCredential = async (orgId: number, type: "google" | "office365" = "google") => {
  if (type === "google") {
    const encryptedServiceAccountKey = {
      type: "service_account",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      client_id: "CLIENT_ID",
      token_uri: "https://oauth2.googleapis.com/token",
      project_id: "PROJECT_ID",
      encrypted_credentials: `{"private_key": "PRIVATE_KEY"}`,
      client_email: "CLIENT_EMAIL",
      private_key_id: "PRIVATE_KEY_ID",
      universe_domain: "googleapis.com",
      client_x509_cert_url: "CLIENT_X509_CERT_URL",
      auth_provider_x509_cert_url: "AUTH_PROVIDER_X509_CERT_URL",
    };

    const workspace = await prisma.workspacePlatform.create({
      data: {
        name: "Test Workspace",
        slug: "google",
        description: "Test Workspace",
        defaultServiceAccountKey: encryptedServiceAccountKey,
        enabled: true,
      },
    });

    const decryptedServiceAccountKey = {
      type: "service_account",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      client_id: "CLIENT_ID",
      token_uri: "https://oauth2.googleapis.com/token",
      project_id: "PROJECT_ID",
      private_key: "PRIVATE_KEY",
      client_email: "CLIENT_EMAIL",
      private_key_id: "PRIVATE_KEY_ID",
      universe_domain: "googleapis.com",
      client_x509_cert_url: "CLIENT_X509_CERT_URL",
      auth_provider_x509_cert_url: "AUTH_PROVIDER_X509_CERT_URL",
    };

    const delegationCredential = await prisma.delegationCredential.create({
      data: {
        workspacePlatform: {
          connect: {
            id: workspace.id,
          },
        },
        domain: "example.com",
        enabled: true,
        organization: {
          connect: {
            id: orgId,
          },
        },
        serviceAccountKey: workspace.defaultServiceAccountKey as unknown as Prisma.InputJsonValue,
      },
    });

    return { ...delegationCredential, serviceAccountKey: decryptedServiceAccountKey };
  } else if (type === "office365") {
    const encryptedServiceAccountKey = {
      client_id: "CLIENT_ID",
      encrypted_credentials: `{"private_key": "PRIVATE_KEY"}`,
      tenant_id: "TENANT_ID",
    };

    const workspace = await prisma.workspacePlatform.create({
      data: {
        name: "Test Workspace",
        slug: "office365",
        description: "Test Workspace",
        defaultServiceAccountKey: encryptedServiceAccountKey,
        enabled: true,
      },
    });

    const decryptedServiceAccountKey = {
      client_id: "CLIENT_ID",
      private_key: "PRIVATE_KEY",
      tenant_id: "TENANT_ID",
    };

    const delegationCredential = await prisma.delegationCredential.create({
      data: {
        workspacePlatform: {
          connect: {
            id: workspace.id,
          },
        },
        domain: "example.com",
        enabled: true,
        organization: {
          connect: {
            id: orgId,
          },
        },
        serviceAccountKey: workspace.defaultServiceAccountKey as unknown as Prisma.InputJsonValue,
      },
    });

    return { ...delegationCredential, serviceAccountKey: decryptedServiceAccountKey };
  }
  throw new Error(`Unsupported type: ${type}`);
};

export const buildDelegationCredential = ({ serviceAccountKey }: { serviceAccountKey: any }) => {
  return {
    id: -1,
    key: {
      access_token: "NOOP_UNUSED_DELEGATION_TOKEN",
    },
    delegatedTo: {
      serviceAccountKey,
    },
  };
};
