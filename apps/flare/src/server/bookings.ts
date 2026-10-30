import common from "../../../../packages/i18n/locales/en/common.json" with { type: "json" };
import type { Interval } from "../domain/scheduling.ts";
import type { Settings } from "../domain/settings.ts";
import { parseSettings } from "../domain/settings.ts";
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

type Options = { db: D1Database; calendar: Calendar; settings: Settings; secret: string; now?: () => number };
type Pending = Pick<Command, "action" | "error">;
const MINUTE = 60_000;
const encoder = new TextEncoder();
async function identity(context: string, value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${context}:${value}`)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class BookingService {
  private readonly db: D1DatabaseSession;
  private readonly calendar: Calendar;
  private readonly settings: Settings;
  private readonly secret: string;
  private readonly now: () => number;
  private readonly delivery: BookingDelivery;
  constructor(options: Options) {
    this.db = options.db.withSession("first-primary");
    this.calendar = options.calendar;
    this.settings = structuredClone(options.settings);
    this.secret = options.secret;
    this.now = options.now ?? Date.now;
    this.delivery = new BookingDelivery({
      db: this.db,
      calendar: this.calendar,
      now: this.now,
      availability: {
        condition: (desired, exclude, settings) => this.scheduler(settings).condition(desired, exclude),
      },
    });
  }
  private scheduler(settings: Settings = this.settings): BookingAvailability {
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
  private async result(command: Command, payload: string, manage = false): Promise<BookingView> {
    if (command.payload !== payload) throw new ErrorWithCode("idempotency_mismatch", 409);
    if (command.outcome !== "accepted") throw new ErrorWithCode(command.outcome, 409);
    await this.delivery.process(command.id);
    const view = await this.render(await this.booking(command.booking_id));
    return manage ? { ...view, manageToken: await this.token(command.booking_id) } : view;
  }
  private async replay(requestKey: string, payload: string, manage = false): Promise<BookingView | null> {
    const command = await this.db
      .prepare("SELECT * FROM booking_command WHERE request_key=?")
      .bind(requestKey)
      .first<Command>();
    return command ? this.result(command, payload, manage) : null;
  }
  async create(input: unknown): Promise<BookingView> {
    const data = parseCreate(input),
      payload = JSON.stringify(data);
    const replay = await this.replay(data.requestKey, payload, true);
    if (replay) return replay;
    const settings = parseSettings(this.settings);
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
    };
    return this.admit(
      {
        requestKey: data.requestKey,
        payload,
        id,
        commandId,
        action: "create",
        version: 0,
        desired,
        tokenHash: await hash(await this.token(id)),
        precondition: await this.scheduler().condition(desired),
      },
      true
    );
  }
  async change(id: string, token: string, input: unknown): Promise<BookingView> {
    return this.changeBooking(await this.authorized(id, token), parseChange(input), "attendee");
  }
  async ownerView(id: string): Promise<BookingView> {
    return this.render(await this.booking(id));
  }
  async ownerChange(id: string, input: unknown): Promise<BookingView> {
    return this.changeBooking(await this.booking(id), parseChange(input), "owner");
  }
  private async changeBooking(
    booking: Booking,
    data: ReturnType<typeof parseChange>,
    actor: "owner" | "attendee"
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
    const replay = await this.replay(requestKey, payload);
    if (replay) return replay;
    if (actor === "owner" && data.action === "cancel" && !data.cancellationReason)
      throw new ErrorWithCode("invalid_input");
    parseSettings(this.settings);
    const commandId = await identity("calflare:command:v1", requestKey);
    const original = snapshot(booking.confirmed_json ?? booking.initial_json);
    const desired = {
      ...original,
      ...(start === undefined ? {} : { start, end: start + original.end - original.start }),
      privateMetadata: { ...original.privateMetadata, operation: commandId },
    };
    const disabled =
      action === "cancel" ? this.settings.event.disableCancelling : this.settings.event.disableRescheduling;
    const precondition =
      disabled || ((action === "cancel" || actor === "owner") && original.end < this.now())
        ? "invalid_slot"
        : action === "cancel" ||
            booking.pending_id ||
            booking.version !== version ||
            booking.state !== "active"
          ? "accepted"
          : await this.scheduler().condition(desired, id);
    return this.admit({
      requestKey,
      payload,
      id,
      commandId,
      action,
      version,
      desired,
      tokenHash: "",
      precondition,
    });
  }
  private async admit(
    input: {
      requestKey: string;
      payload: string;
      id: string;
      commandId: string;
      action: Action;
      version: number;
      desired: BookingSnapshot;
      tokenHash: string;
      precondition: SlotCondition;
    },
    manage = false
  ): Promise<BookingView> {
    const { beforeMinutes, afterMinutes } = this.settings.event;
    try {
      await this.db.batch([
        this.db
          .prepare(`INSERT INTO booking_command(id,request_key,booking_id,action,payload,expected_version,
        desired_json,settings_json,token_hash,occupied_start,occupied_end,precondition,due)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_key) DO UPDATE SET
        id=excluded.id,request_key=excluded.request_key,booking_id=excluded.booking_id,
        action=excluded.action,payload=excluded.payload,expected_version=excluded.expected_version,
        desired_json=excluded.desired_json,settings_json=excluded.settings_json,token_hash=excluded.token_hash,
        occupied_start=excluded.occupied_start,occupied_end=excluded.occupied_end,precondition=excluded.precondition`)
          .bind(
            input.commandId,
            input.requestKey,
            input.id,
            input.action,
            input.payload,
            input.version,
            JSON.stringify(input.desired),
            JSON.stringify(parseSettings(this.settings)),
            input.tokenHash,
            input.desired.start - beforeMinutes * MINUTE,
            input.desired.end + afterMinutes * MINUTE,
            input.precondition,
            this.now()
          ),
      ]);
    } catch (error) {
      const replay = await this.replay(input.requestKey, input.payload, manage);
      if (replay) return replay;
      throw error;
    }
    const result = await this.replay(input.requestKey, input.payload, manage);
    if (!result) throw new ErrorWithCode("temporarily_unavailable", 503);
    return result;
  }
  async view(id: string, token: string): Promise<BookingView> {
    return this.render(await this.authorized(id, token));
  }
  async retry(id: string, token: string): Promise<BookingView> {
    await this.authorized(id, token);
    return this.ownerRetry(id);
  }
  async ownerRetry(id: string): Promise<BookingView> {
    const booking = await this.booking(id);
    if (booking.pending_id) await this.delivery.process(booking.pending_id);
    return this.render(await this.booking(id));
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
      completed.payload AS completed_payload
      FROM booking b LEFT JOIN booking_command c ON c.id = b.pending_id
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
        }
      >();
    const visible = rows.results.slice(0, limit);
    return {
      older: rows.results.length > limit ? (visible.at(-1)?.cursor ?? null) : null,
      bookings: await Promise.all(
        visible.map((row) =>
          this.render(
            row,
            row.pending_action ? { action: row.pending_action, error: row.pending_error } : null,
            row.completed_payload
          )
        )
      ),
    };
  }
  private async render(
    booking: Booking,
    loadedPending?: Pending | null,
    loadedCompleted?: string | null
  ): Promise<BookingView> {
    const event = snapshot(booking.confirmed_json ?? booking.initial_json);
    const pending =
      loadedPending !== undefined
        ? loadedPending
        : booking.pending_id
          ? await this.db
              .prepare("SELECT * FROM booking_command WHERE id=?")
              .bind(booking.pending_id)
              .first<Command>()
          : null;
    let status: BookingView["status"] = "confirmed";
    if (booking.state === "cancelled") status = "cancelled";
    if (pending?.action === "create") status = "pending";
    if (pending?.action === "reschedule") status = "rescheduling";
    if (pending?.action === "cancel") status = "cancelling";
    if (pending?.error) status = "attention";
    let cancellationReason: string | undefined;
    let rescheduleReason: string | undefined;
    if (status === "cancelled" || status === "confirmed") {
      const payload =
        loadedCompleted !== undefined
          ? loadedCompleted
          : await this.db
              .prepare(`SELECT payload FROM booking_command WHERE booking_id=?
          AND accepted_version=? AND action=? AND outcome='accepted'
          AND terminal=1 AND execution='done'`)
              .bind(booking.id, booking.version, status === "cancelled" ? "cancel" : "reschedule")
              .first<string>("payload");
      if (payload) {
        try {
          const { id, ...request } = record(JSON.parse(payload));
          const data = parseChange(request);
          if (id === booking.id) {
            if (status === "cancelled" && data.action === "cancel")
              cancellationReason = data.cancellationReason;
            if (status === "confirmed" && data.action === "reschedule")
              rescheduleReason = data.rescheduleReason;
          }
        } catch {
          cancellationReason = undefined;
          rescheduleReason = undefined;
        }
      }
    }
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
      ...(this.settings.event.disableCancelling === undefined
        ? {}
        : { disableCancelling: this.settings.event.disableCancelling }),
      ...(this.settings.event.disableRescheduling === undefined
        ? {}
        : { disableRescheduling: this.settings.event.disableRescheduling }),
      ...(pending ? { pendingAction: pending.action } : {}),
      ...(pending?.error ? { error: pending.error } : {}),
      ...(cancellationReason ? { cancellationReason } : {}),
      ...(rescheduleReason ? { rescheduleReason } : {}),
    };
  }
  async availability(
    from: number,
    to: number,
    visitorTimeZone: string,
    exclude?: { id: string; token: string }
  ): Promise<Interval[]> {
    const booking = exclude ? await this.authorized(exclude.id, exclude.token) : undefined;
    return this.scheduler().slots(from, to, visitorTimeZone, booking);
  }
  async ownerAvailability(
    id: string,
    from: number,
    to: number,
    visitorTimeZone: string
  ): Promise<Interval[]> {
    const booking = await this.booking(id);
    if (booking.pending_id) throw new ErrorWithCode("busy", 409);
    const original = snapshot(booking.confirmed_json ?? booking.initial_json);
    if (booking.state !== "active" || this.settings.event.disableRescheduling || original.end < this.now())
      throw new ErrorWithCode("invalid_slot", 409);
    return this.scheduler().slots(from, to, visitorTimeZone, booking);
  }
  async recover(limit = 20): Promise<void> {
    return this.delivery.recover(limit);
  }
}
