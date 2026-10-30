import { useEffect, useRef, useState } from "react";
import { BookerClient, ErrorWithCode } from "../client/bookings.ts";
import type { EventDetails, OwnerEvent } from "../domain/settings.ts";
import { parseEventDetails } from "../domain/settings.ts";
import { Button } from "./Button.tsx";
import { Input } from "./Input.tsx";
import { Label } from "./Label.tsx";
import { TextArea } from "./TextArea.tsx";

type Labels = Record<
  | "title"
  | "slug"
  | "description"
  | "location"
  | "locationHelp"
  | "locationLimit"
  | "duration"
  | "minutes"
  | "save"
  | "saved"
  | "preview"
  | "invalid"
  | "failed"
  | "javascript"
  | "create"
  | "uncertain"
  | "refresh"
  | "candidates",
  string
>;

type Mode = { kind: "create" } | { kind: "edit"; id: string };
const client = new BookerClient();
function uncertainCreation(mode: Mode, failure: unknown): boolean {
  return mode.kind === "create" && (!(failure instanceof ErrorWithCode) || failure.retryable);
}

export function OwnerEventEditor({
  mode,
  details,
  labels,
}: {
  mode: Mode;
  details: EventDetails;
  labels: Labels;
}) {
  const [saved, setSaved] = useState(details);
  const [status, setStatus] = useState<
    "loading" | "idle" | "saving" | "saved" | "invalid" | "failed" | "uncertain" | "refreshing"
  >("loading");
  const [candidates, setCandidates] = useState<OwnerEvent[]>([]);
  const active = useRef(0);
  const locked = useRef(false);
  useEffect(() => {
    setStatus("idle");
    return () => {
      active.current++;
    };
  }, []);
  async function refresh() {
    if (status === "refreshing") return;
    const ticket = ++active.current;
    setStatus("refreshing");
    try {
      const events = await client.ownerEvents();
      if (ticket === active.current) setCandidates(events);
    } catch {
      if (ticket === active.current) setCandidates([]);
    } finally {
      if (ticket === active.current) setStatus("uncertain");
    }
  }
  async function saveDetails(next: EventDetails) {
    locked.current = true;
    const ticket = ++active.current;
    setStatus("saving");
    try {
      if (mode.kind === "create") {
        const created = await client.ownerCreateEvent(next);
        if (ticket === active.current) location.assign(`/?eventId=${created.id}`);
        return;
      }
      await client.ownerSaveEvent(mode.id, next);
      if (ticket !== active.current) return;
      setSaved(next);
      setStatus("saved");
      locked.current = false;
    } catch (failure) {
      if (ticket !== active.current) return;
      const uncertain = uncertainCreation(mode, failure);
      locked.current = uncertain;
      setStatus(uncertain ? "uncertain" : "failed");
    }
  }
  return (
    <div className="space-y-4 border-subtle border-t pt-6">
      <h2 id="event-editor-heading" className="break-words font-semibold text-emphasis">
        {mode.kind === "create" ? labels.create : saved.title}
      </h2>
      {mode.kind === "edit" && (
        <a className="text-default block underline" href={`/${saved.slug}`}>
          {labels.preview}
        </a>
      )}
      <form
        aria-labelledby="event-editor-heading"
        method="post"
        action={mode.kind === "create" ? "/api/owner/events" : `/api/owner/events/${mode.id}`}
        onSubmit={async (event) => {
          event.preventDefault();
          if (locked.current || status === "loading") return;
          const form = new FormData(event.currentTarget);
          let next: EventDetails;
          try {
            next = parseEventDetails({
              title: form.get("title"),
              slug: form.get("slug"),
              description: form.get("description"),
              location: form.get("location"),
              durationMinutes: Number(form.get("durationMinutes")),
            });
          } catch {
            setStatus("invalid");
            return;
          }
          await saveDetails(next);
        }}>
        <fieldset disabled={status === "loading" || status === "saving"} className="space-y-4">
          <Label htmlFor="event-title">{labels.title}</Label>
          <Input id="event-title" name="title" defaultValue={details.title} required maxLength={100} />
          <Label htmlFor="event-slug">{labels.slug}</Label>
          <Input
            id="event-slug"
            name="slug"
            defaultValue={details.slug}
            required
            maxLength={100}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            autoCapitalize="none"
            spellCheck={false}
          />
          <Label htmlFor="event-description">{labels.description}</Label>
          <TextArea
            id="event-description"
            name="description"
            defaultValue={details.description}
            maxLength={2000}
            rows={4}
          />
          <Label htmlFor="event-location">{labels.location}</Label>
          <TextArea
            id="event-location"
            name="location"
            defaultValue={details.location ?? ""}
            rows={3}
            aria-invalid={status === "invalid"}
            aria-describedby="event-location-help event-location-limit"
          />
          <p id="event-location-help" className="text-subtle text-sm">
            {labels.locationHelp}
          </p>
          <p id="event-location-limit" className="text-subtle text-sm">
            {labels.locationLimit}
          </p>
          <Label htmlFor="event-duration">
            {labels.duration} ({labels.minutes})
          </Label>
          <Input
            id="event-duration"
            name="durationMinutes"
            type="number"
            defaultValue={details.durationMinutes}
            required
            min={5}
            max={480}
            step={1}
          />
          <Button
            type="submit"
            loading={status === "saving"}
            disabled={status === "uncertain" || status === "refreshing"}>
            {mode.kind === "create" ? labels.create : labels.save}
          </Button>
        </fieldset>
        <noscript>
          <p className="mt-4 text-sm">{labels.javascript}</p>
        </noscript>
        {status === "saved" && (
          <p role="status" className="mt-4 text-sm">
            {labels.saved}
          </p>
        )}
        {(status === "invalid" || status === "failed") && (
          <p role="alert" className="mt-4 text-sm">
            {labels[status]}
          </p>
        )}
      </form>
      {(status === "uncertain" || status === "refreshing") && (
        <div className="space-y-3">
          <p role="alert">{labels.uncertain}</p>
          <Button
            type="button"
            color="secondary"
            loading={status === "refreshing"}
            onClick={() => void refresh()}>
            {labels.refresh}
          </Button>
          {candidates.length > 0 && (
            <nav aria-label={labels.candidates} className="space-y-2">
              <p>{labels.candidates}</p>
              {candidates.map((entry) => (
                <a className="block break-words underline" key={entry.id} href={`/?eventId=${entry.id}`}>
                  {entry.event.title} /{entry.event.slug}
                </a>
              ))}
            </nav>
          )}
        </div>
      )}
    </div>
  );
}
