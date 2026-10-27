import { useRef, useState } from "react";

export function ButtonCases({ Button }) {
  const [count, setCount] = useState(0);
  const ref = useRef(null);
  return (
    <main className="mx-auto flex w-full max-w-sm flex-col items-start gap-4 rounded-xl border border-default bg-default p-6 text-default">
      {["primary", "secondary", "minimal", "destructive"].map((color) => (
        <div key={color} className="flex flex-wrap gap-2">
          <Button color={color}>Confirm</Button>
          <Button color={color} disabled>
            Disabled
          </Button>
          <Button color={color} loading data-testid="loading">
            Loading
          </Button>
        </div>
      ))}
      {["xs", "sm", "base", "lg"].map((size) => (
        <div key={size} className="flex gap-2">
          <Button size={size} color="secondary" StartIcon="clock" EndIcon="chevron-right">
            Continue
          </Button>
          <Button
            size={size}
            color="minimal"
            variant="icon"
            StartIcon="chevron-left"
            aria-label={`Previous ${size}`}
          />
        </div>
      ))}
      <Button className="h-12 rounded-none bg-red-500 px-8" data-testid="override">
        Override
      </Button>
      <Button CustomStartIcon={<span aria-hidden="true">+</span>} StartIcon="clock">
        Custom icon
      </Button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setCount((value) => value + 1);
        }}>
        <Button
          ref={ref}
          data-testid="interactive"
          onClick={() => {
            if (ref.current?.tagName !== "BUTTON") throw new Error("Native button ref missing");
            setCount((value) => value + 1);
          }}>
          Choose time
        </Button>
        <Button type="submit" data-testid="submit">
          Submit
        </Button>
        <Button disabled data-testid="disabled" onClick={() => setCount(999)}>
          Unavailable
        </Button>
        <output aria-label="Actions">{count}</output>
      </form>
    </main>
  );
}
