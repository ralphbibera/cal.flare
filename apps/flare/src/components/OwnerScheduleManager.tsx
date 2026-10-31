import { useEffect, useRef, useState } from "react";
import type { ScheduleCatalog } from "../client/bookings.ts";
import { BookerClient, ErrorWithCode } from "../client/bookings.ts";
import { Button } from "./Button.tsx";
import { Input } from "./Input.tsx";
import { Label } from "./Label.tsx";
import { OwnerOverridesEditor } from "./OwnerOverridesEditor.tsx";
import { OwnerScheduleEditor } from "./OwnerScheduleEditor.tsx";
import type { scheduleLabels } from "./schedule-labels.ts";

type Creation = { kind: "create"; name: string } | { kind: "duplicate"; id: string; name: string };
type Intent =
  | Creation
  | { kind: "rename"; id: string; name: string }
  | { kind: "default"; id: string }
  | { kind: "delete"; id: string; name: string };
type State =
  | { kind: "loading" | "idle" | "refreshing" | "saved" | "refreshFailed" }
  | { kind: "pending"; intent: Intent }
  | Acknowledged
  | { kind: "failed"; intent: Intent; final: boolean }
  | { kind: "uncertain"; intent: Creation };
type Acknowledged = { kind: "acknowledged"; intent: Intent; selectId?: string };

function catalogReadState(current: State, failed: boolean): State {
  if ("intent" in current) return { ...current };
  return { kind: failed ? "refreshFailed" : "idle" };
}

async function applyIntent(
  client: BookerClient,
  intent: Intent,
  signal: AbortSignal,
  knownIds: ReadonlySet<string>
): Promise<string | undefined> {
  switch (intent.kind) {
    case "create":
    case "duplicate": {
      const source = intent.kind === "duplicate" ? intent.id : undefined;
      const created = await client.ownerCreateSchedule(intent.name, source, signal);
      if (knownIds.has(created.id)) throw new ErrorWithCode("invalid_response", 201);
      return created.id;
    }
    case "rename":
      await client.ownerRenameSchedule(intent.id, intent.name, signal);
      return;
    case "default":
      await client.ownerDefaultSchedule(intent.id, signal);
      return;
    case "delete":
      await client.ownerDeleteSchedule(intent.id, signal);
      return;
  }
}

function failure(intent: Intent, error: unknown): State {
  if (
    (intent.kind === "create" || intent.kind === "duplicate") &&
    (!(error instanceof ErrorWithCode) || error.retryable)
  )
    return { kind: "uncertain", intent };
  return { kind: "failed", intent, final: error instanceof ErrorWithCode && error.code === "final_schedule" };
}

function ScheduleResult({
  state,
  catalog,
  labels: l,
  retry,
  back,
}: {
  state: State;
  catalog: ScheduleCatalog;
  labels: ReturnType<typeof scheduleLabels>["manager"];
  retry: (intent: Intent) => void;
  back: () => void;
}) {
  const actions = {
    create: l.create,
    duplicate: l.duplicate,
    rename: l.rename,
    default: l.makeDefault,
    delete: l.remove,
  };
  if (state.kind === "loading" || state.kind === "refreshing") return <p role="status">{l.loading}</p>;
  if (state.kind === "saved") return <p role="status">{l.saved}</p>;
  if (state.kind === "refreshFailed") return <p role="alert">{l.failed}</p>;
  if (!("intent" in state)) return null;
  if (state.kind === "pending") return <p role="status">{actions[state.intent.kind]}…</p>;
  let message = l.acknowledged;
  if (state.kind === "uncertain") message = l.uncertain;
  if (state.kind === "failed") message = state.final ? l.final : l.failed;
  return (
    <div className="space-y-3 rounded-md border border-subtle p-3">
      <p role="alert">{message}</p>
      <p className="break-words">
        {actions[state.intent.kind]} {"name" in state.intent && state.intent.name}{" "}
        {"id" in state.intent && `(${state.intent.id})`}
      </p>
      {state.kind === "failed" && (
        <>
          <Button onClick={() => retry(state.intent)}>{l.retry}</Button>
          <Button color="secondary" onClick={back}>
            {l.back}
          </Button>
        </>
      )}
      {state.kind === "uncertain" && (
        <nav aria-label={l.candidates} className="space-y-2">
          {catalog.schedules.map(({ id, name }) => (
            <a key={id} className="block break-words underline" href={`/owner/schedules?scheduleId=${id}`}>
              {name} ({id})
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}

export function OwnerScheduleManager({
  initial,
  selectedId,
  labels,
}: {
  initial: ScheduleCatalog;
  selectedId: string;
  labels: ReturnType<typeof scheduleLabels>;
}) {
  const l = labels.manager;
  const [catalog, setCatalog] = useState(initial);
  const [selected, setSelected] = useState(selectedId);
  const [drafts, setDrafts] = useState({
    create: "",
    duplicate: "",
    rename: initial.schedules.find(({ id }) => id === selectedId)?.name ?? "",
  });
  const [state, setState] = useState<State>({ kind: "loading" });
  const [confirm, setConfirm] = useState<{ id: string; name: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const lock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const active = useRef(false);
  const backFocus = useRef<HTMLButtonElement>(null);
  const confirmFocus = useRef<HTMLButtonElement>(null);
  const selectionFocus = useRef<HTMLSelectElement>(null);
  const returning = useRef(false);
  useEffect(() => {
    active.current = true;
    setState({ kind: "idle" });
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!["idle", "saved", "refreshFailed"].includes(state.kind)) return;
    if (confirm) confirmFocus.current?.focus();
    else if (returning.current) {
      (backFocus.current ?? selectionFocus.current)?.focus();
      returning.current = false;
    }
  }, [confirm, state.kind]);
  const record = catalog.schedules.find(({ id }) => id === selected);
  const blocked = !["idle", "saved", "refreshFailed"].includes(state.kind) || editing;
  const client = new BookerClient();

  function acceptCatalog(next: ScheduleCatalog, ack?: Acknowledged) {
    setCatalog(next);
    if (!ack) {
      setState(catalogReadState(state, false));
      return;
    }
    const target = ack.selectId ?? (ack.intent.kind === "delete" ? next.defaultScheduleId : selected);
    const targetRecord = next.schedules.find(({ id }) => id === target);
    if (!targetRecord) {
      setState({ ...ack });
      return;
    }
    setSelected(target);
    window.history.replaceState(null, "", `/owner/schedules?scheduleId=${target}`);
    if (target !== selected) setDrafts((current) => ({ ...current, rename: targetRecord.name }));
    setConfirm(null);
    setState({ kind: "saved" });
  }

  async function refresh(ack?: Acknowledged) {
    if (lock.current || !active.current) return;
    lock.current = true;
    const request = new AbortController();
    controller.current = request;
    if (!ack) setState({ kind: "refreshing" });
    try {
      const next = await client.ownerSchedules(request.signal);
      if (request.signal.aborted) return;
      acceptCatalog(next, ack);
    } catch {
      if (!request.signal.aborted) setState(catalogReadState(ack ?? state, true));
    } finally {
      lock.current = false;
    }
  }

  async function submit(intent: Intent) {
    if (lock.current || !active.current) return;
    lock.current = true;
    const request = new AbortController();
    controller.current = request;
    setState({ kind: "pending", intent });
    const knownIds = new Set(catalog.schedules.map(({ id }) => id));
    let selectId: string | undefined;
    try {
      selectId = await applyIntent(client, intent, request.signal, knownIds);
      if (!active.current || request.signal.aborted) return;
    } catch (error) {
      if (!active.current || request.signal.aborted) return;
      setState(failure(intent, error));
      return;
    } finally {
      lock.current = false;
    }
    const ack = { kind: "acknowledged", intent, selectId } satisfies State;
    setState(ack);
    await refresh(ack);
  }

  function editorSaving(saving: boolean) {
    lock.current = saving;
    setEditing(saving);
    if (!saving) void refresh();
  }

  const nameForm = (kind: "create" | "duplicate" | "rename") => (
    <form
      aria-label={l[kind]}
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked || confirm || !drafts[kind].trim()) return;
        const name = drafts[kind].trim();
        if (kind === "create") void submit({ kind, name });
        else if (record) void submit({ kind, id: record.id, name });
      }}>
      <fieldset
        disabled={blocked || confirm !== null || (kind !== "create" && !record)}
        className="min-w-0 space-y-2">
        <Label htmlFor={`schedule-${kind}-name`}>
          {l[kind]} · {l.name}
        </Label>
        <Input
          id={`schedule-${kind}-name`}
          required
          pattern={".*\\S.*"}
          maxLength={100}
          value={drafts[kind]}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setDrafts((current) => ({ ...current, [kind]: value }));
          }}
        />
        {kind !== "rename" && (
          <p className="text-sm text-subtle">{kind === "create" ? l.createHelp : l.duplicateHelp}</p>
        )}
        <Button type="submit">{l[kind]}</Button>
      </fieldset>
    </form>
  );

  return (
    <div className="space-y-6">
      <h1 className="font-semibold text-emphasis text-xl">{l.heading}</h1>
      <p className="text-sm">{l.help}</p>
      <p className="break-words text-sm">
        {l.default} {catalog.schedules.find(({ id }) => id === catalog.defaultScheduleId)?.name} (
        {catalog.defaultScheduleId})
      </p>
      <Label htmlFor="schedule-selection">{l.select}</Label>
      <select
        id="schedule-selection"
        ref={selectionFocus}
        className="block w-full min-w-0 rounded-md border border-default bg-default p-2 text-sm"
        value={selected}
        disabled={blocked || confirm !== null}
        onChange={(event) => {
          if (lock.current) return;
          const id = event.currentTarget.value;
          setSelected(id);
          setDrafts((current) => ({
            ...current,
            rename: catalog.schedules.find((entry) => entry.id === id)?.name ?? "",
          }));
          setState({ kind: "idle" });
          window.history.replaceState(null, "", `/owner/schedules?scheduleId=${id}`);
        }}>
        {!record && <option value={selected}>{selected}</option>}
        {catalog.schedules.map(({ id, name }) => (
          <option key={id} value={id}>
            {name} ({id})
          </option>
        ))}
      </select>
      <Button
        color="secondary"
        disabled={
          lock.current ||
          state.kind === "pending" ||
          editing ||
          state.kind === "loading" ||
          state.kind === "refreshing"
        }
        onClick={() => void refresh(state.kind === "acknowledged" ? state : undefined)}>
        {l.refresh}
      </Button>
      <ScheduleResult
        state={state}
        catalog={catalog}
        labels={l}
        retry={(intent) => void submit(intent)}
        back={() => {
          returning.current = true;
          setConfirm(null);
          setState({ kind: "idle" });
        }}
      />
      {nameForm("create")}
      {record ? (
        <section className="space-y-6" aria-labelledby="selected-schedule-title">
          <h2 id="selected-schedule-title" className="break-words font-semibold">
            {record.name} <span className="text-sm text-subtle">({record.id})</span>
          </h2>
          {nameForm("rename")}
          {nameForm("duplicate")}
          <Button
            disabled={blocked || confirm !== null || selected === catalog.defaultScheduleId}
            onClick={() => void submit({ kind: "default", id: record.id })}>
            {l.makeDefault}
          </Button>
          <div className="space-y-3">
            <Button
              ref={backFocus}
              color="secondary"
              disabled={blocked || confirm !== null || catalog.schedules.length === 1}
              onClick={() => setConfirm({ id: record.id, name: record.name })}>
              {l.remove}
            </Button>
            {catalog.schedules.length === 1 && <p className="text-sm">{l.final}</p>}
            {confirm && (
              <section aria-label={l.confirm} className="space-y-3">
                <p className="break-words">
                  {confirm.name} ({confirm.id})
                </p>
                <p>{l.warning}</p>
                <Button
                  ref={confirmFocus}
                  disabled={blocked}
                  onClick={() => void submit({ kind: "delete", ...confirm })}>
                  {l.confirm}
                </Button>
                <Button
                  color="secondary"
                  disabled={blocked}
                  onClick={() => {
                    returning.current = true;
                    setConfirm(null);
                  }}>
                  {l.back}
                </Button>
              </section>
            )}
          </div>
          <fieldset disabled={blocked || confirm !== null} className="min-w-0 space-y-6" key={record.id}>
            <OwnerScheduleEditor
              scheduleId={record.id}
              schedule={record.schedule}
              labels={labels.weekly}
              onSaving={editorSaving}
            />
            <OwnerOverridesEditor
              scheduleId={record.id}
              overrides={record.schedule.overrides ?? []}
              labels={labels.overrides}
              onSaving={editorSaving}
            />
          </fieldset>
        </section>
      ) : (
        <p role="alert">{l.missing}</p>
      )}
      <noscript>{l.javascript}</noscript>
    </div>
  );
}
