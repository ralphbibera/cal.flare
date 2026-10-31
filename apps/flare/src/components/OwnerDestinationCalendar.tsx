import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "./Button.tsx";
import { Label } from "./Label.tsx";

const id = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !/\s|\p{Cc}/u.test(value));
const discovery = z
  .object({
    calendars: z
      .array(z.object({ id, name: z.string().min(1).max(4096), primary: z.boolean() }).strict())
      .max(1000)
      .refine(
        (items) =>
          new Set(items.map(({ id }) => id)).size === items.length &&
          items.every(({ id, primary }) => primary === (id === "primary"))
      ),
    ownerDefault: id,
    eventOverride: id.nullable(),
  })
  .strict();
const acknowledgement = z.object({ saved: z.literal(true) }).strict();
type Choice = z.infer<typeof discovery>["calendars"][number];
type Labels = Record<
  | "heading"
  | "help"
  | "primary"
  | "follow"
  | "unavailable"
  | "reload"
  | "loading"
  | "loadFailed"
  | "saveFailed"
  | "save"
  | "saved"
  | "reset"
  | "reconnect"
  | "javascript",
  string
>;

async function saveDestination(endpoint: string, value: string | null, signal: AbortSignal): Promise<void> {
  const response = await fetch(endpoint, {
    method: "PATCH",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ calendarId: value }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (response.status !== 200) throw new Error();
  acknowledgement.parse(await response.json());
}

export function OwnerDestinationCalendar({
  selection,
  eventId,
  labels,
}: {
  selection: string | null;
  eventId?: string;
  labels: Labels;
}) {
  const control = eventId ? "event-destination-calendar" : "owner-destination-calendar";
  const [saved, setSaved] = useState(selection);
  const [draft, setDraft] = useState(selection);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [load, setLoad] = useState<"loading" | "ready" | "failed">("loading");
  const [save, setSave] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const pending = useRef<AbortController | null>(null);
  const active = useRef(false);
  const endpoint = `/api/owner/destination-calendars${eventId ? `?eventId=${encodeURIComponent(eventId)}` : ""}`;
  const resetValue = eventId ? null : "primary";

  const reload = useCallback(
    async (controller = new AbortController()) => {
      if (pending.current) return;
      pending.current = controller;
      setLoad("loading");
      try {
        const response = await fetch(endpoint, {
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        });
        if (!response.ok) throw new Error();
        const value = discovery.parse(await response.json());
        if (controller.signal.aborted) return;
        setChoices(value.calendars);
        setLoad("ready");
      } catch {
        if (!controller.signal.aborted) setLoad("failed");
      } finally {
        if (pending.current === controller) pending.current = null;
      }
    },
    [endpoint]
  );

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    void reload(controller);
    return () => {
      active.current = false;
      controller.abort();
      pending.current?.abort();
    };
  }, [reload]);

  async function persist(value: string | null) {
    if (pending.current || !active.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setSave("saving");
    try {
      await saveDestination(endpoint, value, controller.signal);
      if (controller.signal.aborted) return;
      const canonical = value ?? resetValue;
      setSaved(canonical);
      setDraft(canonical);
      setSave("saved");
    } catch {
      if (!controller.signal.aborted) setSave("failed");
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }

  const available = new Set(choices.map(({ id }) => id));
  const missing = [...new Set([saved, draft])].filter(
    (id): id is string => id !== null && !available.has(id)
  );
  const locked = load === "loading" || save === "saving";
  return (
    <section className="min-w-0 space-y-3 border-subtle border-t pt-6" aria-labelledby={`${control}-title`}>
      <h2 id={`${control}-title`} className="font-semibold">
        {labels.heading}
      </h2>
      <p id={`${control}-help`} className="text-sm text-subtle">
        {labels.help}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void persist(draft);
        }}>
        <fieldset disabled={locked} className="min-w-0 space-y-3">
          <Label htmlFor={control}>{labels.heading}</Label>
          <select
            id={control}
            aria-describedby={`${control}-help`}
            value={draft ?? ""}
            className="block w-full min-w-0 rounded-md border border-default bg-default p-2 text-sm"
            onChange={(event) => {
              setDraft(event.currentTarget.value || null);
              setSave("idle");
            }}>
            {eventId && <option value="">{labels.follow}</option>}
            {choices.map(({ id, name }) => (
              <option key={id} value={id}>
                {name} ({id === "primary" ? labels.primary : id})
              </option>
            ))}
            {missing.map((id) => (
              <option key={id} value={id}>
                {id} ({labels.unavailable})
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              loading={save === "saving"}
              disabled={draft !== null && !available.has(draft)}>
              {labels.save}
            </Button>
            <Button
              type="button"
              color="secondary"
              onClick={() => {
                void persist(null);
              }}>
              {labels.reset}
            </Button>
            <Button
              type="button"
              color="secondary"
              onClick={() => {
                void reload();
              }}>
              {labels.reload}
            </Button>
          </div>
        </fieldset>
      </form>
      {load === "loading" && <p role="status">{labels.loading}</p>}
      {load === "failed" && (
        <p role="alert">
          {labels.loadFailed}{" "}
          <a href="/api/auth/login" className="underline">
            {labels.reconnect}
          </a>
        </p>
      )}
      {save === "failed" && <p role="alert">{labels.saveFailed}</p>}
      {save === "saved" && <p role="status">{labels.saved}</p>}
      <noscript>{labels.javascript}</noscript>
    </section>
  );
}
