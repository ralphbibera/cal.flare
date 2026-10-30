import type { Interval } from "../domain/scheduling.ts";
import { availableSlots, isValidTimeZone, MAX_QUERY_DAYS } from "../domain/scheduling.ts";
import type { Settings } from "../domain/settings.ts";
import { parseSettings } from "../domain/settings.ts";
import type { Booking, BookingSnapshot, Calendar } from "./booking-model.ts";
import { snapshot, timestamp } from "./booking-model.ts";
import { ErrorWithCode } from "./http.ts";

const MINUTE = 60_000;
const DAY = 86_400_000;
export type SlotCondition = "accepted" | "conflict" | "invalid_slot";

export class BookingAvailability {
  private readonly settings: Settings;
  private readonly db: D1DatabaseSession;
  private readonly calendar: Pick<Calendar, "busy">;
  private readonly now: () => number;
  constructor(
    db: D1DatabaseSession,
    calendar: Pick<Calendar, "busy">,
    settings: Settings,
    now: () => number
  ) {
    this.settings = parseSettings(settings);
    this.db = db;
    this.calendar = calendar;
    this.now = now;
  }

  async condition(
    desired: BookingSnapshot,
    excludeId?: string,
    settings: Settings = this.settings
  ): Promise<SlotCondition> {
    const start = timestamp(desired.start),
      end = timestamp(desired.end),
      now = this.now();
    if (start < now || end > now + 365 * DAY) return "invalid_slot";
    const slots = availableSlots({
      schedule: settings.schedule,
      // Reschedule displays can round in another zone, so validate their exact selected interval.
      policy: {
        ...settings.event,
        durationMinutes: (end - start) / MINUTE,
        intervalMinutes: excludeId === undefined ? settings.event.intervalMinutes : 1,
      },
      from: start,
      to: end,
      visitorTimeZone: desired.timeZone,
      now,
      busy: [],
    });
    if (!slots.some((slot) => slot.start === start)) return "invalid_slot";
    const from = start - settings.event.beforeMinutes * MINUTE,
      to = end + settings.event.afterMinutes * MINUTE;
    const busy = await this.calendar.busy(
      new Date(from).toISOString(),
      new Date(to).toISOString(),
      excludeId,
      settings.conflictCalendarIds
    );
    return busy.some((range) => range.start < to && from < range.end) ? "conflict" : "accepted";
  }

  async slots(from: number, to: number, visitorTimeZone: string, exclude?: Booking): Promise<Interval[]> {
    timestamp(from);
    timestamp(to);
    if (from >= to || to - from > MAX_QUERY_DAYS * DAY || to > this.now() + 365 * DAY)
      throw new ErrorWithCode("invalid_range");
    if (!isValidTimeZone(visitorTimeZone)) throw new ErrorWithCode("invalid_input");
    let durationMinutes = this.settings.event.durationMinutes;
    let windowTimeZone: string | undefined;
    if (exclude) {
      const event = snapshot(exclude.confirmed_json ?? exclude.initial_json);
      durationMinutes = (event.end - event.start) / MINUTE;
      windowTimeZone = event.timeZone;
    }
    const start = from - this.settings.event.beforeMinutes * MINUTE,
      end = to + this.settings.event.afterMinutes * MINUTE;
    const remote = await this.calendar.busy(
      new Date(start).toISOString(),
      new Date(end).toISOString(),
      exclude?.id,
      this.settings.conflictCalendarIds
    );
    const local = await this.db
      .prepare("SELECT start,end FROM booking_reservation WHERE start < ? AND end > ? AND booking_id <> ?")
      .bind(end, start, exclude?.id ?? "")
      .all<Interval>();
    return availableSlots({
      schedule: this.settings.schedule,
      policy: { ...this.settings.event, durationMinutes },
      from,
      to,
      visitorTimeZone,
      windowTimeZone,
      now: this.now(),
      busy: [...remote, ...local.results],
    });
  }
}
