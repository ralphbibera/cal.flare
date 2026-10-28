import { useRef, useState } from "react";

export function InputCases({ Input }) {
  const [name, setName] = useState("Ada");
  const [submitted, setSubmitted] = useState(0);
  const [target, setTarget] = useState("none");
  const ref = useRef(null);
  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-4 rounded-xl border border-default bg-default p-6 text-default">
      <Input
        aria-label="Name"
        ref={ref}
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      <Input aria-label="Small" size="sm" placeholder="Short value" />
      <Input aria-label="Disabled" disabled defaultValue="No editing" />
      <Input aria-label="Read only" readOnly defaultValue="Read only" />
      <Input aria-label="Override" className="h-10 w-40 rounded-none" defaultValue="Custom classes" />
      <Input
        aria-label="Narrow"
        isFullWidth={false}
        size={null}
        className="h-9"
        defaultValue="Natural width"
      />
      <Input aria-label="Count" type="number" min={1} max={9} step={1} defaultValue={3} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted((value) => value + 1);
        }}>
        <Input
          aria-label="Email"
          type="email"
          required
          placeholder="guest@example.test"
          autoComplete="email"
        />
        <button type="submit">Submit</button>
      </form>
      <button
        type="button"
        onClick={() => {
          ref.current?.focus();
          setTarget(ref.current?.tagName ?? "missing");
        }}>
        Focus name
      </button>
      <output aria-label="Name value">{name}</output>
      <output aria-label="Submissions">{submitted}</output>
      <output aria-label="Ref target">{target}</output>
    </main>
  );
}
