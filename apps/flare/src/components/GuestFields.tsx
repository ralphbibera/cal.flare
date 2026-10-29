import type { ReactElement } from "react";
import { useLayoutEffect, useRef } from "react";
import { parseGuests } from "../domain/guests.ts";
import { Button } from "./Button.tsx";
import type { bookingLabels } from "./booking-labels.ts";
import { Icon } from "./Icon.tsx";
import { Input } from "./Input.tsx";
import { Label } from "./Label.tsx";

type GuestRow = { id: string; value: string };
type GuestFieldsProps = {
  rows: readonly GuestRow[];
  onChange: (rows: GuestRow[]) => void;
  readOnly: boolean;
  invalid: boolean;
  labels: typeof bookingLabels;
};

function GuestFields({ rows, onChange, readOnly, invalid, labels }: GuestFieldsProps): ReactElement {
  const group = useRef<HTMLDivElement>(null);
  const focus = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (focus.current === null) return;
    const target =
      group.current?.querySelectorAll("input")[Math.min(focus.current, rows.length - 1)] ??
      group.current?.querySelector("button");
    target?.focus();
    focus.current = null;
  }, [rows.length]);
  function add(): void {
    focus.current = rows.length;
    onChange([...rows, { id: crypto.randomUUID(), value: "" }]);
  }
  return (
    <div
      ref={group}
      role="group"
      aria-label={labels.guests}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? "guests-error" : undefined}>
      {rows.length > 0 && (
        <>
          <p className="mb-1 font-medium text-default text-sm">{labels.addGuests}</p>
          <ul className="space-y-1">
            {rows.map(({ id, value }, index) => {
              const duplicate = value !== "" && rows.filter((row) => row.value === value).length > 1;
              const affected = invalid && (duplicate || value === "" || parseGuests([value]) === null);
              return (
                <li key={id} className="relative">
                  <Label htmlFor={`guests.${index}`} className="sr-only">
                    {labels.guestEmail.replace("{{index}}", String(index + 1))}
                  </Label>
                  <Input
                    id={`guests.${index}`}
                    name={`guests.${index}`}
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="pr-10 font-medium"
                    value={value}
                    readOnly={readOnly}
                    aria-invalid={affected || undefined}
                    aria-describedby={affected ? "guests-error" : undefined}
                    onChange={(event) =>
                      onChange(
                        rows.map((row, position) =>
                          position === index ? { ...row, value: event.target.value.toLowerCase() } : row
                        )
                      )
                    }
                  />
                  {!readOnly && (
                    <Button
                      type="button"
                      color="minimal"
                      className="absolute top-0 right-0 h-8 w-8 justify-center p-0"
                      aria-label={labels.removeGuest.replace("{{index}}", String(index + 1))}
                      onClick={() => {
                        focus.current = Math.max(0, Math.min(index, rows.length - 2));
                        onChange(rows.filter((_, position) => position !== index));
                      }}>
                      <Icon name="x" size={12} />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {!readOnly && (
        <Button
          type="button"
          color="minimal"
          StartIcon="user-plus"
          className={rows.length ? "my-2.5" : "mr-auto h-fit whitespace-normal text-left"}
          onClick={add}>
          {rows.length ? labels.addAnother : labels.addGuests}
        </Button>
      )}
      {invalid && (
        <p id="guests-error" role="alert">
          {rows.some(
            ({ value }, index) => value !== "" && rows.findIndex((row) => row.value === value) !== index
          )
            ? labels.duplicateEmail
            : labels.guestError}
        </p>
      )}
    </div>
  );
}

export { GuestFields, type GuestRow };
