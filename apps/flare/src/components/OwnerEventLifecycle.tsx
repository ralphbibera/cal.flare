import { useEffect, useRef, useState } from "react";
import { BookerClient } from "../client/bookings.ts";
import type { OwnerEvent } from "../domain/settings.ts";
import { Button } from "./Button.tsx";
import { Input } from "./Input.tsx";
import { Label } from "./Label.tsx";

type Stage =
  | { kind: "loading" | "idle" | "saving" | "saved" | "failed" | "checking" }
  | { kind: "confirm" | "removing" | "removeFailed"; event: Pick<OwnerEvent["event"], "title" | "slug"> };
type Labels = Record<
  | "heading"
  | "hidden"
  | "help"
  | "save"
  | "saved"
  | "failed"
  | "duplicate"
  | "remove"
  | "confirm"
  | "warning"
  | "back"
  | "removeFailed"
  | "javascript",
  string
>;
const client = new BookerClient();

export function OwnerEventLifecycle({
  id,
  lifecycle,
  labels,
}: {
  id: string;
  lifecycle: OwnerEvent["lifecycle"];
  labels: Labels;
}) {
  const [hidden, setHidden] = useState(lifecycle === "hidden");
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const active = useRef(0);
  const locked = useRef(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const removal = "event" in stage ? stage : null;
  const pending = ["loading", "saving", "checking", "removing"].includes(stage.kind);
  useEffect(() => {
    setStage({ kind: "idle" });
    return () => {
      active.current++;
    };
  }, []);
  useEffect(() => {
    if (stage.kind === "confirm") backButton.current?.focus();
  }, [stage.kind]);

  async function saveVisibility() {
    if (locked.current || removal || stage.kind === "loading") return;
    locked.current = true;
    const ticket = ++active.current;
    setStage({ kind: "saving" });
    try {
      await client.ownerSetVisibility(id, hidden);
      if (ticket === active.current) setStage({ kind: "saved" });
    } catch {
      if (ticket === active.current) setStage({ kind: "failed" });
    } finally {
      locked.current = false;
    }
  }
  async function confirmRemoval() {
    if (locked.current || removal || stage.kind === "loading") return;
    locked.current = true;
    const ticket = ++active.current;
    setStage({ kind: "checking" });
    try {
      const saved = await client.ownerEvent(id);
      if (ticket === active.current) setStage({ kind: "confirm", event: saved.event });
    } catch {
      if (ticket === active.current) setStage({ kind: "failed" });
    } finally {
      locked.current = false;
    }
  }
  async function remove() {
    if (locked.current || !removal) return;
    locked.current = true;
    const ticket = ++active.current;
    setStage({ kind: "removing", event: removal.event });
    try {
      await client.ownerRemoveEvent(id);
      if (ticket === active.current) location.assign("/");
    } catch {
      if (ticket === active.current) setStage({ kind: "removeFailed", event: removal.event });
      locked.current = false;
    }
  }
  return (
    <section aria-labelledby="event-lifecycle-heading" className="space-y-4 border-subtle border-t pt-6">
      <h2 id="event-lifecycle-heading" className="font-semibold text-emphasis">
        {labels.heading}
      </h2>
      <form
        aria-label={labels.heading}
        onSubmit={(event) => {
          event.preventDefault();
          void saveVisibility();
        }}>
        <fieldset disabled={pending || removal !== null} className="space-y-3">
          <Label htmlFor="event-hidden" className="flex items-center gap-2">
            <Input
              id="event-hidden"
              type="checkbox"
              isFullWidth={false}
              className="h-4 w-4 shrink-0"
              checked={hidden}
              onChange={(event) => {
                setHidden(event.target.checked);
                setStage({ kind: "idle" });
              }}
              aria-describedby="event-visibility-help"
            />
            {labels.hidden}
          </Label>
          <p id="event-visibility-help" className="text-sm text-subtle">
            {labels.help}
          </p>
          <Button type="submit" loading={stage.kind === "saving"}>
            {labels.save}
          </Button>
        </fieldset>
        {stage.kind === "saved" && (
          <p role="status" className="mt-3">
            {labels.saved}
          </p>
        )}
        {stage.kind === "failed" && (
          <p role="alert" className="mt-3">
            {labels.failed}
          </p>
        )}
      </form>
      <a
        href={`/?duplicate=${id}`}
        aria-disabled={pending || removal !== null}
        onClick={(event) => {
          if (locked.current || pending || removal) event.preventDefault();
        }}
        className="block underline">
        {labels.duplicate}
      </a>
      <Button
        ref={removeButton}
        color="destructive"
        disabled={pending || stage.kind === "removeFailed"}
        loading={stage.kind === "checking"}
        onClick={() => void confirmRemoval()}>
        {labels.remove}
      </Button>
      {removal && (
        <div role="group" aria-label={labels.confirm} className="space-y-3 break-words">
          <p className="font-semibold">
            {removal.event.title} /{removal.event.slug}
          </p>
          <p>{labels.warning}</p>
          <div className="flex flex-wrap gap-3">
            {stage.kind === "confirm" && (
              <Button
                ref={backButton}
                color="secondary"
                onClick={() => {
                  setStage({ kind: "idle" });
                  removeButton.current?.focus();
                }}>
                {labels.back}
              </Button>
            )}
            <Button color="destructive" loading={stage.kind === "removing"} onClick={() => void remove()}>
              {labels.confirm}
            </Button>
          </div>
          {stage.kind === "removeFailed" && <p role="alert">{labels.removeFailed}</p>}
        </div>
      )}
      <noscript>
        <p>{labels.javascript}</p>
      </noscript>
    </section>
  );
}
