import { useEffect, useState } from "react";
import type { EventDetails } from "../domain/settings.ts";
import { parseEventDetails } from "../domain/settings.ts";
import { Button } from "./Button.tsx";

type Labels = Record<
  | "title"
  | "slug"
  | "description"
  | "duration"
  | "minutes"
  | "save"
  | "saved"
  | "preview"
  | "invalid"
  | "failed"
  | "javascript",
  string
>;

export function OwnerEventEditor({ details, labels }: { details: EventDetails; labels: Labels }) {
  const [saved, setSaved] = useState(details);
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "saved" | "invalid" | "failed">(
    "loading"
  );
  useEffect(() => setStatus("idle"), []);
  const field =
    "bg-default border-default text-default mt-1 block w-full rounded-md border px-3 py-2 text-sm";
  return (
    <div className="space-y-4 border-subtle border-t pt-6">
      <h2 className="break-words font-semibold text-emphasis">{saved.title}</h2>
      <a className="text-default block underline" href={`/${saved.slug}`}>
        {labels.preview}
      </a>
      <form
        method="post"
        action="/api/owner"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          let next: EventDetails;
          try {
            next = parseEventDetails({
              title: form.get("title"),
              slug: form.get("slug"),
              description: form.get("description"),
              durationMinutes: Number(form.get("durationMinutes")),
            });
          } catch {
            setStatus("invalid");
            return;
          }
          setStatus("saving");
          try {
            const response = await fetch("/api/owner", {
              method: "PATCH",
              credentials: "same-origin",
              cache: "no-store",
              redirect: "error",
              signal: AbortSignal.timeout(30_000),
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(next),
            });
            const result: unknown = await response.json();
            if (
              !response.ok ||
              typeof result !== "object" ||
              result === null ||
              !("saved" in result) ||
              result.saved !== true
            )
              throw new Error();
            setSaved(next);
            setStatus("saved");
          } catch {
            setStatus("failed");
          }
        }}>
        <fieldset disabled={status === "loading" || status === "saving"} className="space-y-4">
          <label className="block text-sm" htmlFor="event-title">
            {labels.title}
          </label>
          <input
            id="event-title"
            className={field}
            name="title"
            defaultValue={details.title}
            required
            maxLength={100}
          />
          <label className="block text-sm" htmlFor="event-slug">
            {labels.slug}
          </label>
          <input
            id="event-slug"
            className={field}
            name="slug"
            defaultValue={details.slug}
            required
            maxLength={100}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            autoCapitalize="none"
            spellCheck={false}
          />
          <label className="block text-sm" htmlFor="event-description">
            {labels.description}
          </label>
          <textarea
            id="event-description"
            className={field}
            name="description"
            defaultValue={details.description}
            maxLength={2000}
            rows={4}
          />
          <label className="block text-sm" htmlFor="event-duration">
            {labels.duration} ({labels.minutes})
          </label>
          <input
            id="event-duration"
            className={field}
            name="durationMinutes"
            type="number"
            defaultValue={details.durationMinutes}
            required
            min={5}
            max={480}
            step={1}
          />
          <Button type="submit" loading={status === "saving"}>
            {labels.save}
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
    </div>
  );
}
