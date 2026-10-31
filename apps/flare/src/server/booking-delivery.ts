import { parseSettings } from "../domain/settings.ts";
import type { BookingAvailability } from "./booking-availability.ts";
import type { Booking, BookingSnapshot, Calendar, Command } from "./booking-model.ts";
import { integer, matches, snapshot } from "./booking-model.ts";
import { GoogleCalendarError } from "./google.ts";
import { ErrorWithCode } from "./http.ts";

type Options = {
  db: D1DatabaseSession;
  calendar: Calendar;
  availability: Pick<BookingAvailability, "condition">;
  now: () => number;
};

function notApplied(error: unknown): error is GoogleCalendarError {
  if (!(error instanceof GoogleCalendarError)) return false;
  if (!error.dispatched) return true;
  return error.kind !== "ambiguous" && [400, 401, 403, 404, 405, 422, 429].includes(error.status);
}

type RecoveryFact =
  | { kind: "complete"; etag: string | null }
  | { kind: "attention"; reason: string }
  | { kind: "continue"; baseEtag: string | null }
  | { kind: "stale" };
type Remote = Awaited<ReturnType<Calendar["get"]>>;

function sentRecovery(command: Command, desired: BookingSnapshot, remote: Remote): RecoveryFact {
  if (command.execution === "sent") {
    if (command.action === "cancel" && !remote) return { kind: "complete", etag: null };
    if (
      remote &&
      command.action !== "cancel" &&
      matches(remote, desired) &&
      (command.action === "create" || remote.etag !== command.base_etag)
    )
      return { kind: "complete", etag: remote.etag };
    if (command.action === "create")
      return { kind: "attention", reason: remote ? "event_mismatch" : "insert_unresolved" };
  }
  return { kind: "continue", baseEtag: command.base_etag };
}

export class BookingDelivery {
  private readonly db: D1DatabaseSession;
  private readonly calendar: Calendar;
  private readonly availability: Pick<BookingAvailability, "condition">;
  private readonly now: () => number;
  constructor(options: Options) {
    this.db = options.db;
    this.calendar = options.calendar;
    this.availability = options.availability;
    this.now = options.now;
  }

  async recover(limit = 20): Promise<void> {
    integer(limit, 1, 100);
    const now = this.now();
    const rows = await this.db
      .prepare(`SELECT id FROM booking_command WHERE outcome='accepted' AND execution <> 'done'
      AND due <= ? AND lease_until <= ? ORDER BY due LIMIT ?`)
      .bind(now, now, limit)
      .all<{ id: string }>();
    for (const row of rows.results) await this.process(row.id);
  }

  async process(id: string): Promise<void> {
    const nonce = crypto.randomUUID(),
      now = this.now();
    const results = await this.db.batch<Command>([
      this.db
        .prepare(`UPDATE booking_command SET nonce=?,lease_until=?,due=?,attempts=attempts+1
        WHERE id=? AND outcome='accepted' AND terminal=0 AND lease_until <= ?
        AND EXISTS(SELECT 1 FROM booking WHERE pending_id=booking_command.id AND version=booking_command.accepted_version)`)
        .bind(nonce, now + 60_000, now + 60_000, id, now),
      this.db.prepare("SELECT * FROM booking_command WHERE id=? AND nonce=?").bind(id, nonce),
    ]);
    const command = results[1].results[0];
    if (!command) return;
    try {
      await this.run(command, nonce);
    } catch {
      await this.attention(command, nonce, "calendar_unresolved");
    }
  }

  private async attention(command: Command, nonce: string, reason: string): Promise<void> {
    const backoff = Math.min(3600_000, 30_000 * 2 ** Math.min(command.attempts, 7));
    await this.db
      .prepare(`UPDATE booking_command SET error=?,lease_until=0,due=? WHERE id=? AND nonce=? AND terminal=0`)
      .bind(reason, this.now() + backoff, command.id, nonce)
      .run();
  }

  private async finish(command: Command, nonce: string, etag: string | null): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(`UPDATE booking_command SET terminal=1,execution='done',result_etag=?,error=NULL,lease_until=0
      WHERE id=? AND nonce=? AND terminal=0 AND EXISTS(SELECT 1 FROM booking
        WHERE pending_id=booking_command.id AND version=booking_command.accepted_version)`)
        .bind(etag, command.id, nonce),
    ]);
  }

  private async run(command: Command, nonce: string): Promise<void> {
    const desired = snapshot(command.desired_json);
    const booking = await this.db
      .prepare("SELECT * FROM booking WHERE id=?")
      .bind(command.booking_id)
      .first<Booking>();
    if (!booking) throw new ErrorWithCode("not_found", 404);
    const remote =
      command.execution === "sent" || command.action !== "create"
        ? await this.calendar.get(desired.id)
        : null;
    const recovery = await this.reconcile(command, nonce, booking, desired, remote);
    if (recovery.kind === "complete") return this.finish(command, nonce, recovery.etag);
    if (recovery.kind === "attention") return this.attention(command, nonce, recovery.reason);
    if (recovery.kind === "stale") return;
    const baseEtag = recovery.baseEtag;
    if (command.execution === "queued" && command.action !== "cancel") {
      const condition = await this.availability.condition(
        desired,
        command.action === "reschedule" ? desired.id : undefined,
        parseSettings(JSON.parse(command.settings_json))
      );
      if (condition !== "accepted") return this.attention(command, nonce, condition);
    }
    // A lease controls local acknowledgments. The persisted sent flag controls insert authority.
    const sent = await this.db
      .prepare(`UPDATE booking_command SET execution='sent',error=NULL,dispatch_nonce=?
      WHERE id=? AND nonce=? AND terminal=0 AND execution=?
      AND EXISTS(SELECT 1 FROM booking WHERE pending_id=booking_command.id AND version=booking_command.accepted_version)`)
      .bind(nonce, command.id, nonce, command.execution)
      .run();
    if (sent.meta.changes !== 1) return;
    return this.dispatch(command, nonce, desired, baseEtag);
  }

  private async reconcile(
    command: Command,
    nonce: string,
    booking: Booking,
    desired: BookingSnapshot,
    remote: Remote
  ): Promise<RecoveryFact> {
    const recovery = sentRecovery(command, desired, remote);
    if (recovery.kind !== "continue" || command.action === "create") return recovery;
    let baseEtag = recovery.baseEtag;
    const confirmed = booking.confirmed_json ? snapshot(booking.confirmed_json) : null;
    if (!remote || !confirmed || !matches(remote, confirmed))
      return { kind: "attention", reason: "event_changed" };
    if (baseEtag === null && command.execution === "queued") {
      const fixed = await this.db
        .prepare(`UPDATE booking_command SET base_etag=?
          WHERE id=? AND nonce=? AND terminal=0 AND execution='queued' AND base_etag IS NULL
          AND EXISTS(SELECT 1 FROM booking WHERE pending_id=booking_command.id AND version=booking_command.accepted_version)`)
        .bind(remote.etag, command.id, nonce)
        .run();
      if (fixed.meta.changes !== 1) return { kind: "stale" };
      baseEtag = remote.etag;
    }
    if (remote.etag !== baseEtag) return { kind: "attention", reason: "event_changed" };
    return { kind: "continue", baseEtag };
  }

  private async dispatch(
    command: Command,
    nonce: string,
    desired: BookingSnapshot,
    baseEtag: string | null
  ): Promise<void> {
    if (command.action === "create") return this.insert(command, nonce, desired);
    if (!baseEtag) return this.attention(command, nonce, "missing_etag");
    if (command.action === "cancel") {
      await this.calendar.delete(desired.id, baseEtag);
      return this.finish(command, nonce, null);
    }
    const result = await this.calendar.update(desired.id, baseEtag, desired);
    if (result.id !== desired.id || result.etag === baseEtag)
      return this.attention(command, nonce, "event_mismatch");
    return this.finish(command, nonce, result.etag);
  }

  private async insert(command: Command, nonce: string, desired: BookingSnapshot): Promise<void> {
    let result: Awaited<ReturnType<Calendar["insert"]>>;
    try {
      result = await this.calendar.insert(desired);
    } catch (error) {
      if (!notApplied(error)) throw error;
      // Only this dispatch can prove its own rejection, even after a lease takeover.
      await this.db
        .prepare(`UPDATE booking_command SET execution='queued',dispatch_nonce=NULL,nonce=NULL,
          lease_until=0,due=?,error=? WHERE id=? AND dispatch_nonce=? AND execution='sent' AND terminal=0`)
        .bind(
          this.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(command.attempts, 7)),
          `calendar_rejected_${error.status}`,
          command.id,
          nonce
        )
        .run();
      return;
    }
    if (result.id !== desired.id) return this.attention(command, nonce, "event_mismatch");
    return this.finish(command, nonce, result.etag);
  }
}
