import common from "../../../../packages/i18n/locales/en/common.json" with { type: "json" };
import type { Interval } from "../domain/scheduling.ts";
import type { Settings } from "../domain/settings.ts";
import { isWithinMinimumRescheduleNotice } from "../domain/settings.ts";
import type { SlotCondition } from "./booking-availability.ts";
import { BookingAvailability } from "./booking-availability.ts";
import { BookingDelivery } from "./booking-delivery.ts";
import type {
  Action,
  Booking,
  BookingSnapshot,
  BookingView,
  Calendar,
  Command,
  OwnerBookingPage,
  OwnerBookingQuery,
} from "./booking-model.ts";
import { parseChange, parseCreate, snapshot } from "./booking-model.ts";
import { ErrorWithCode, record } from "./http.ts";
import { base64url, encryptionKey, hash } from "./secrets.ts";
import type { AdmissionContext, CurrentActionPolicy } from "./settings.ts";
import {
  currentActionPolicy,
  DEFAULT_EVENT_ID,
  getAdmissionContext,
  getBookableSettings,
  getCurrentActionPolicy,
  getSettings,
} from "./settings.ts";

type Options = {
  db: D1Database;
  calendar: Calendar;
  settings?: Settings;
  secret: string;
  now?: () => number;
};
type Pending = Pick<Command, "action" | "error">;
type Actor = "owner" | "attendee";
const MINUTE = 60_000;
const encoder = new TextEncoder();
async function identity(context: string, value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${context}:${value}`)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function changePolicyRefuses(
  action: ReturnType<typeof parseChange>["action"],
  actor: Actor,
  original: BookingSnapshot,
  policy: CurrentActionPolicy,
  now: number
): boolean {
  const disabled =
    action === "cancel"
      ? policy.disableCancelling
      : policy.disableRescheduling ||
        (actor === "attendee" &&
          isWithinMinimumRescheduleNotice(original.start, now, policy.minimumRescheduleNotice));
  return Boolean(disabled || ((action === "cancel" || actor === "owner") && original.end < now));
}

function bookingStatus(booking: Booking, pending: Pending | null): BookingView["status"] {
  let status: BookingView["status"] = "confirmed";
  if (booking.state === "cancelled") status = "cancelled";
  if (pending?.action === "create") status = "pending";
  if (pending?.action === "reschedule") status = "rescheduling";
  if (pending?.action === "cancel") status = "cancelling";
  if (pending?.error) status = "attention";
  return status;
}

export class BookingService {
  private readonly db: D1DatabaseSession;
  private readonly calendar: Calendar;
  private readonly secret: string;
  private readonly now: () => number;
  private readonly delivery: BookingDelivery;
  constructor(options: Options) {
    this.db = options.db.withSession("first-primary");
    this.calendar = options.calendar;
    this.secret = options.secret;
    this.now = options.now ?? Date.now;
    this.delivery = new BookingDelivery({
      db: this.db,
      calendar: this.calendar,
      now: this.now,
      availability: {
        condition: (desired, exclude, settings, calendarId) => {
          if (!settings) throw new ErrorWithCode("missing_command_settings");
          return this.scheduler(settings).condition(desired, exclude, settings, calendarId);
        },
      },
    });
  }
  private scheduler(settings: Settings): BookingAvailability {
    return new BookingAvailability(this.db, this.calendar, settings, this.now);
  }
  private async token(id: string): Promise<string> {
    await encryptionKey(this.secret);
    const bytes = Uint8Array.from(atob(this.secret), (character) => character.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    return base64url(
      new Uint8Array(
        await crypto.subtle.sign("HMAC", key, encoder.encode(`calflare:booking-management:v1:${id}`))
      )
    );
  }
  private async booking(id: string, token?: string): Promise<Booking> {
    if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) throw new ErrorWithCode("not_found", 404);
    if (token !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ErrorWithCode("not_found", 404);
    const row =
      token === undefined
        ? await this.db.prepare("SELECT * FROM booking WHERE id=?").bind(id).first<Booking>()
        : await this.db
            .prepare("SELECT * FROM booking WHERE id=? AND token_hash=?")
            .bind(id, await hash(token))
            .first<Booking>();
    if (!row) throw new ErrorWithCode("not_found", 404);
    return row;
  }
  private async authorized(id: string, token: string): Promise<Booking> {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new ErrorWithCode("not_found", 404);
    return this.booking(id, token);
  }
  private async result(
    command: Command,
    payload: string,
    eventId: string,
    manage = false,
    actor: Actor = "attendee"
  ): Promise<BookingView> {
    if (command.payload !== payload || command.event_id !== eventId)
      throw new ErrorWithCode("idempotency_mismatch", 409);
    if (command.outcome !== "accepted") throw new ErrorWithCode(command.outcome, 409);
    await this.delivery.process(command.id);
    const view = await this.render(await this.booking(command.booking_id), actor);
    return manage ? { ...view, manageToken: await this.token(command.booking_id) } : view;
  }
  private async replay(
    requestKey: string,
    payload: string,
    eventId: string,
    manage = false,
    actor: Actor = "attendee"
  ): Promise<BookingView | null> {
    const command = await this.db
      .prepare("SELECT * FROM booking_command WHERE request_key=?")
      .bind(requestKey)
      .first<Command>();
    return command ? this.result(command, payload, eventId, manage, actor) : null;
  }
  async create(input: unknown, eventId = DEFAULT_EVENT_ID): Promise<BookingView> {
    const data = parseCreate(input),
      payload = JSON.stringify(data);
    const replay = await this.replay(data.requestKey, payload, eventId, true);
    if (replay) return replay;
    const context = await getAdmissionContext(this.db, eventId, true);
    const { settings } = context;
    const id = await identity("calflare:booking:v1", data.requestKey);
    const commandId = await identity("calflare:command:v1", data.requestKey);
    const desired: BookingSnapshot = {
      id,
      start: data.start,
      end: data.start + settings.event.durationMinutes * MINUTE,
      title: settings.event.title,
      description: data.notes
        ? `${settings.event.description ? `${settings.event.description}\n\n` : ""}${common.additional_notes}:\n${data.notes}`
        : settings.event.description,
      timeZone: data.timeZone,
      attendee: { name: data.name, email: data.email },
      privateMetadata: { application: "calflare", booking: id, operation: commandId },
      ...(data.guests ? { guests: data.guests } : {}),
      ...(settings.event.location === undefined ? {} : { location: settings.event.location }),
    };
    return this.admit(
      {
        requestKey: data.requestKey,
        eventId,
        calendarId: context.calendarId,
        context,
        payload,
        id,
        commandId,
        action: "create",
        version: 0,
        desired,
        tokenHash: await hash(await this.token(id)),
        precondition: await this.scheduler(settings).condition(desired),
      },
      true
    );
  }
  async change(id: string, token: string, input: unknown): Promise<BookingView> {
    return this.changeBooking(await this.authorized(id, token), parseChange(input), "attendee");
  }
  async ownerView(id: string): Promise<BookingView> {
    return this.render(await this.booking(id), "owner");
  }
  async ownerChange(id: string, input: unknown): Promise<BookingView> {
    return this.changeBooking(await this.booking(id), parseChange(input), "owner");
  }
  private async changeBooking(
    booking: Booking,
    data: ReturnType<typeof parseChange>,
    actor: Actor
  ): Promise<BookingView> {
    const id = booking.id;
    const { action, requestKey, version } = data;
    const start = action === "reschedule" ? data.start : undefined;
    const payload = JSON.stringify({
      action,
      id,
      requestKey,
      version,
      ...(start === undefined ? {} : { start }),
      ...(data.action === "reschedule" && data.rescheduleReason
        ? { rescheduleReason: data.rescheduleReason }
        : {}),
      ...(data.action === "cancel" && data.cancellationReason
        ? { cancellationReason: data.cancellationReason }
        : {}),
    });
    const replay = await this.replay(requestKey, payload, booking.event_id, false, actor);
    if (replay) return replay;
    if (actor === "owner" && data.action === "cancel" && !data.cancellationReason)
      throw new ErrorWithCode("invalid_input");
    const context = await getAdmissionContext(this.db, booking.event_id);
    const { settings, policy } = context;
    const now = this.now();
    const commandId = await identity("calflare:command:v1", requestKey);
    const original = snapshot(booking.confirmed_json ?? booking.initial_json);
    const desired = {
      ...original,
      ...(start === undefined ? {} : { start, end: start + original.end - original.start }),
      privateMetadata: { ...original.privateMetadata, operation: commandId },
    };
    const precondition = changePolicyRefuses(action, actor, original, policy, now)
      ? "invalid_slot"
      : action === "cancel" || booking.pending_id || booking.version !== version || booking.state !== "active"
        ? "accepted"
        : await this.scheduler(settings).condition(desired, id, settings, booking.calendar_id);
    return this.admit(
      {
        requestKey,
        eventId: booking.event_id,
        calendarId: booking.calendar_id,
        context,
        payload,
        id,
        commandId,
        action,
        version,
        desired,
        tokenHash: "",
        precondition,
      },
      false,
      actor
    );
  }
  private async admit(
    input: {
      requestKey: string;
      eventId: string;
      calendarId: string;
      context: AdmissionContext;
      payload: string;
      id: string;
      commandId: string;
      action: Action;
      version: number;
      desired: BookingSnapshot;
      tokenHash: string;
      precondition: SlotCondition;
    },
    manage = false,
    actor: Actor = "attendee"
  ): Promise<BookingView> {
    const { settings } = input.context;
    const { beforeMinutes, afterMinutes } = settings.event;
    try {
      await this.db.batch([
        this.db
          .prepare(`INSERT INTO booking_command(id,request_key,booking_id,action,payload,expected_version,
        desired_json,settings_json,token_hash,occupied_start,occupied_end,precondition,due,event_id,event_schedule_id,resolved_schedule_id,
        calendar_id,owner_calendar_id,event_calendar_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_key) DO UPDATE SET
        id=excluded.id,request_key=excluded.request_key,booking_id=excluded.booking_id,
        action=excluded.action,payload=excluded.payload,expected_version=excluded.expected_version,event_id=excluded.event_id,
        desired_json=excluded.desired_json,settings_json=excluded.settings_json,token_hash=excluded.token_hash,
        occupied_start=excluded.occupied_start,occupied_end=excluded.occupied_end,precondition=excluded.precondition,
        event_schedule_id=excluded.event_schedule_id,resolved_schedule_id=excluded.resolved_schedule_id,
        calendar_id=excluded.calendar_id,owner_calendar_id=excluded.owner_calendar_id,event_calendar_id=excluded.event_calendar_id`)
          .bind(
            input.commandId,
            input.requestKey,
            input.id,
            input.action,
            input.payload,
            input.version,
            JSON.stringify(input.desired),
            input.context.settingsJson,
            input.tokenHash,
            input.desired.start - beforeMinutes * MINUTE,
            input.desired.end + afterMinutes * MINUTE,
            input.precondition,
            this.now(),
            input.eventId,
            input.context.eventScheduleId,
            input.context.resolvedScheduleId,
            input.calendarId,
            input.context.ownerCalendarId,
            input.context.eventCalendarId
          ),
      ]);
    } catch (error) {
      const replay = await this.replay(input.requestKey, input.payload, input.eventId, manage, actor);
      if (replay) return replay;
      throw error;
    }
    const result = await this.replay(input.requestKey, input.payload, input.eventId, manage, actor);
    if (!result) throw new ErrorWithCode("temporarily_unavailable", 503);
    return result;
  }
  async view(id: string, token: string): Promise<BookingView> {
    return this.render(await this.authorized(id, token), "attendee");
  }
  async retry(id: string, token: string): Promise<BookingView> {
    await this.authorized(id, token);
    return this.retryBooking(id, "attendee");
  }
  async ownerRetry(id: string): Promise<BookingView> {
    return this.retryBooking(id, "owner");
  }
  private async retryBooking(id: string, actor: Actor): Promise<BookingView> {
    const booking = await this.booking(id);
    if (booking.pending_id) await this.delivery.process(booking.pending_id);
    return this.render(await this.booking(id), actor);
  }
  async ownerList(): Promise<BookingView[]> {
    return (await this.ownerRows({ filter: "all", before: null }, 1000)).bookings;
  }
  async ownerPage(query: OwnerBookingQuery): Promise<OwnerBookingPage> {
    return this.ownerRows(query, 25);
  }
  private async ownerRows(query: OwnerBookingQuery, limit: number): Promise<OwnerBookingPage> {
    const now = this.now();
    const rows = await this.db
      .prepare(`SELECT b.*, b.rowid AS cursor, c.action AS pending_action, c.error AS pending_error,
      completed.payload AS completed_payload, e.json AS event_json, e.lifecycle, o.json AS preferences_json,
      s.json AS schedule_json
      FROM booking b LEFT JOIN booking_command c ON c.id = b.pending_id
      LEFT JOIN event_type e ON e.id=b.event_id
      LEFT JOIN organizer_settings o ON o.id='owner'
      LEFT JOIN availability_schedule s ON s.id=COALESCE(e.schedule_id,o.default_schedule_id)
      LEFT JOIN booking_command completed ON completed.booking_id=b.id
      AND completed.accepted_version=b.version
      AND ((b.state='cancelled' AND completed.action='cancel') OR (b.state='active' AND completed.action='reschedule'))
      AND completed.outcome='accepted' AND completed.terminal=1 AND completed.execution='done'
      WHERE (? IS NULL OR b.rowid < ?)
      AND (?='all' OR (?='cancelled' AND b.state='cancelled')
        OR (b.state <> 'cancelled' AND (
          (?='upcoming' AND json_extract(COALESCE(b.confirmed_json,b.initial_json),'$.end') > ?)
          OR (?='past' AND json_extract(COALESCE(b.confirmed_json,b.initial_json),'$.end') <= ?))))
      ORDER BY b.rowid DESC LIMIT ?`)
      .bind(
        query.before,
        query.before,
        query.filter,
        query.filter,
        query.filter,
        now,
        query.filter,
        now,
        limit + 1
      )
      .all<
        Booking & {
          cursor: number;
          pending_action: Action | null;
          pending_error: string | null;
          completed_payload: string | null;
          event_json: string | null;
          preferences_json: string | null;
          schedule_json: string | null;
          lifecycle: "listed" | "hidden" | "removed" | null;
        }
      >();
    const visible = rows.results.slice(0, limit);
    return {
      older: rows.results.length > limit ? (visible.at(-1)?.cursor ?? null) : null,
      bookings: await Promise.all(
        visible.map((row) =>
          this.render(
            row,
            "owner",
            row.pending_action ? { action: row.pending_action, error: row.pending_error } : null,
            row.completed_payload,
            currentActionPolicy(row)
          )
        )
      ),
    };
  }
  private async completedChangeReasons(
    booking: Booking,
    status: BookingView["status"],
    loadedCompleted?: string | null
  ): Promise<Pick<BookingView, "cancellationReason" | "rescheduleReason">> {
    if (status !== "cancelled" && status !== "confirmed") return {};
    const payload =
      loadedCompleted !== undefined
        ? loadedCompleted
        : await this.db
            .prepare(`SELECT payload FROM booking_command WHERE booking_id=?
          AND accepted_version=? AND action=? AND outcome='accepted'
          AND terminal=1 AND execution='done'`)
            .bind(booking.id, booking.version, status === "cancelled" ? "cancel" : "reschedule")
            .first<string>("payload");
    if (!payload) return {};
    try {
      const { id, ...request } = record(JSON.parse(payload));
      const data = parseChange(request);
      if (id !== booking.id) return {};
      if (status === "cancelled" && data.action === "cancel")
        return { cancellationReason: data.cancellationReason };
      if (status === "confirmed" && data.action === "reschedule")
        return { rescheduleReason: data.rescheduleReason };
    } catch {
      return {};
    }
    return {};
  }
  private async render(
    booking: Booking,
    actor: Actor,
    loadedPending?: Pending | null,
    loadedCompleted?: string | null,
    loadedPolicy?: CurrentActionPolicy
  ): Promise<BookingView> {
    const event = snapshot(booking.confirmed_json ?? booking.initial_json);
    const policy = loadedPolicy ?? (await getCurrentActionPolicy(this.db, booking.event_id));
    const disableRescheduling =
      actor === "attendee" &&
      isWithinMinimumRescheduleNotice(event.start, this.now(), policy.minimumRescheduleNotice)
        ? true
        : policy.disableRescheduling;
    const pending =
      loadedPending !== undefined
        ? loadedPending
        : booking.pending_id
          ? await this.db
              .prepare("SELECT * FROM booking_command WHERE id=?")
              .bind(booking.pending_id)
              .first<Command>()
          : null;
    const status = bookingStatus(booking, pending);
    const { cancellationReason, rescheduleReason } = await this.completedChangeReasons(
      booking,
      status,
      loadedCompleted
    );
    return {
      id: booking.id,
      status,
      version: booking.version,
      start: event.start,
      end: event.end,
      name: event.attendee.name,
      email: event.attendee.email,
      timeZone: event.timeZone,
      title: event.title,
      ...(policy.disableCancelling === undefined ? {} : { disableCancelling: policy.disableCancelling }),
      ...(disableRescheduling === undefined ? {} : { disableRescheduling }),
      ...(pending ? { pendingAction: pending.action } : {}),
      ...(pending?.error ? { error: pending.error } : {}),
      ...(cancellationReason ? { cancellationReason } : {}),
      ...(rescheduleReason ? { rescheduleReason } : {}),
      ...(status === "confirmed" && booking.confirmed_json && event.location !== undefined
        ? { location: event.location }
        : {}),
    };
  }
  async availability(
    from: number,
    to: number,
    visitorTimeZone: string,
    exclude?: { id: string; token: string },
    eventId = DEFAULT_EVENT_ID
  ): Promise<Interval[]> {
    const booking = exclude ? await this.authorized(exclude.id, exclude.token) : undefined;
    const settings = await getBookableSettings(this.db, booking?.event_id ?? eventId);
    if (
      booking &&
      (settings.event.disableRescheduling ||
        isWithinMinimumRescheduleNotice(
          snapshot(booking.confirmed_json ?? booking.initial_json).start,
          this.now(),
          settings.event.minimumRescheduleNotice
        ))
    )
      throw new ErrorWithCode("invalid_slot", 409);
    return this.scheduler(settings).slots(from, to, visitorTimeZone, booking);
  }
  async ownerAvailability(
    id: string,
    from: number,
    to: number,
    visitorTimeZone: string
  ): Promise<Interval[]> {
    const booking = await this.booking(id);
    const settings = await getSettings(this.db, booking.event_id);
    const policy = await getCurrentActionPolicy(this.db, booking.event_id);
    if (booking.pending_id) throw new ErrorWithCode("busy", 409);
    const original = snapshot(booking.confirmed_json ?? booking.initial_json);
    if (booking.state !== "active" || policy.disableRescheduling || original.end < this.now())
      throw new ErrorWithCode("invalid_slot", 409);
    return this.scheduler(settings).slots(from, to, visitorTimeZone, booking);
  }
  async recover(limit = 20): Promise<void> {
    return this.delivery.recover(limit);
  }
}
