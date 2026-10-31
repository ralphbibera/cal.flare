import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { parseConflictCalendarIds } from "../domain/settings.ts";
import { Button } from "./Button.tsx";

const calendar = z
  .object({
    id: z
      .string()
      .min(1)
      .max(1024)
      .refine((id) => !/\s|\p{Cc}/u.test(id)),
    name: z
      .string()
      .max(4096)
      .refine((name) => name.trim().length > 0),
    primary: z.boolean(),
  })
  .strict();
const discovery = z
  .object({
    calendars: z
      .array(calendar)
      .max(1000)
      .refine(
        (items) =>
          new Set(items.map(({ id }) => id)).size === items.length &&
          items.every(({ id, primary }) => primary === (id === "primary"))
      ),
    conflictCalendarIds: z.unknown().transform(parseSelection),
  })
  .strict();
const acknowledgement = z.object({ saved: z.literal(true) }).strict();
type Calendar = z.infer<typeof calendar>;
type Selection = string[] | null;
type Labels = Record<
  | "heading"
  | "help"
  | "primary"
  | "default"
  | "empty"
  | "unavailable"
  | "removeUnavailable"
  | "loading"
  | "loadFailed"
  | "saveFailed"
  | "retry"
  | "reconnect"
  | "save"
  | "saved"
  | "reset"
  | "clear"
  | "limit"
  | "javascript",
  string
>;

function parseSelection(ids: unknown): Selection {
  return ids === null ? null : parseConflictCalendarIds(ids);
}

function selectionPresentation({
  saved,
  draft,
  calendars,
  labels,
}: {
  saved: Selection;
  draft: Selection;
  calendars: Calendar[];
  labels: Labels;
}) {
  const selected = draft ?? ["primary"];
  const choices = new Map(calendars.map((item) => [item.id, item]));
  for (const id of new Set([...(saved ?? ["primary"]), ...selected])) {
    if (!choices.has(id))
      choices.set(id, { id, name: id === "primary" ? labels.primary : id, primary: id === "primary" });
  }
  const eligible = new Set(calendars.map(({ id }) => id));
  const unavailable = selected.some((id) => !eligible.has(id));
  let description = labels.limit;
  if (draft === null) description = labels.default;
  else if (selected.length === 0) description = labels.empty;
  return { selected, choices, eligible, unavailable, description };
}

export function OwnerConflictCalendars({ selection, labels }: { selection: Selection; labels: Labels }) {
  const [saved, setSaved] = useState(selection);
  const [draft, setDraft] = useState(selection);
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [load, setLoad] = useState<"loading" | "ready" | "failed">("loading");
  const [save, setSave] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const pending = useRef<AbortController | null>(null);

  async function discover() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoad("loading");
    try {
      const response = await fetch("/api/owner/conflict-calendars", {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok) throw new Error();
      const result = discovery.parse(await response.json());
      if (controller.signal.aborted) return;
      setCalendars(result.calendars);
      setLoad("ready");
    } catch {
      if (!controller.signal.aborted) setLoad("failed");
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }

  useEffect(() => {
    void discover();
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, []);

  async function persist(next: Selection) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setSave("saving");
    try {
      const ids = parseSelection(next);
      const response = await fetch("/api/owner/conflict-calendars", {
        method: "PATCH",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conflictCalendarIds: ids }),
      });
      if (!response.ok) throw new Error();
      acknowledgement.parse(await response.json());
      if (controller.signal.aborted) return;
      setSaved(ids);
      setDraft(ids);
      setSave("saved");
    } catch {
      if (!controller.signal.aborted) setSave("failed");
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }

  const { selected, choices, eligible, unavailable, description } = selectionPresentation({
    saved,
    draft,
    calendars,
    labels,
  });
  const busy = load === "loading" || save === "saving";
  const blocked = selected.length > 0 && (load !== "ready" || unavailable);

  return (
    <section className="border-subtle min-w-0 border-t pt-6">
      <h2 id="owner-conflict-title" className="text-emphasis mb-4 font-semibold">
        {labels.heading}
      </h2>
      <p id="owner-conflict-help" className="text-subtle mb-4 text-sm">
        {labels.help}
      </p>
      <form
        aria-labelledby="owner-conflict-title"
        aria-describedby="owner-conflict-help"
        onSubmit={(event) => {
          event.preventDefault();
          if (!blocked) void persist(draft);
        }}>
        <fieldset disabled={busy} className="min-w-0 space-y-4">
          <p className="text-subtle text-sm">{description}</p>
          {Array.from(choices.values()).map(({ id, name }) => (
            <label key={id} className="flex min-w-0 items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 shrink-0"
                checked={selected.includes(id)}
                disabled={!selected.includes(id) && selected.length >= 50}
                onChange={(event) => {
                  setDraft(
                    event.currentTarget.checked ? [...selected, id] : selected.filter((value) => value !== id)
                  );
                  setSave("idle");
                }}
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span>{name}</span>
                {load === "ready" && !eligible.has(id) && (
                  <span className="text-subtle block">{labels.unavailable}</span>
                )}
              </span>
            </label>
          ))}
          {load === "ready" && unavailable && (
            <p className="text-subtle text-sm">{labels.removeUnavailable}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={blocked}>
              {labels.save}
            </Button>
            <Button color="secondary" onClick={() => void persist(null)}>
              {labels.reset}
            </Button>
            <Button
              color="secondary"
              onClick={() => {
                setDraft([]);
                setSave("idle");
              }}>
              {labels.clear}
            </Button>
          </div>
          <Button color="secondary" onClick={() => void discover()}>
            {labels.retry}
          </Button>
        </fieldset>
        {load === "loading" && (
          <p role="status" className="mt-3 text-sm">
            {labels.loading}
          </p>
        )}
        {load === "failed" && (
          <div className="mt-3 space-y-2 text-sm">
            <p role="alert">{labels.loadFailed}</p>
            <a
              href="/api/auth/login"
              className="underline"
              aria-disabled={save === "saving"}
              onClick={(event) => {
                if (save === "saving") event.preventDefault();
              }}>
              {labels.reconnect}
            </a>
          </div>
        )}
        {save === "failed" && (
          <p role="alert" className="mt-3 text-sm">
            {labels.saveFailed}
          </p>
        )}
        {save === "saved" && (
          <p role="status" className="mt-3 text-sm">
            {labels.saved}
          </p>
        )}
      </form>
      <noscript>
        <p className="mt-3 text-sm">{labels.javascript}</p>
      </noscript>
    </section>
  );
}
