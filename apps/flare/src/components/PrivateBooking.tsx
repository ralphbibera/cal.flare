import { useEffect, useState } from "react";
import { BookerClient, type BookingAccess } from "../client/bookings.ts";
import { restoreManagementAccess } from "../client/management-access.ts";
import { BookingManagement } from "./BookingManagement.tsx";
import { Button } from "./Button.tsx";
import type { bookingLabels } from "./booking-labels.ts";

type Booking = Awaited<ReturnType<BookerClient["view"]>>;
type State = { kind: "loading" | "unavailable" } | { kind: "ready"; access: BookingAccess; booking: Booking };
const client = new BookerClient();

export function PrivateBooking({ id, labels }: { id: string; labels: typeof bookingLabels }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  async function load() {
    setState({ kind: "loading" });
    try {
      let access: BookingAccess;
      try {
        access = restoreManagementAccess({ id, fragment: location.hash, storage: sessionStorage });
      } finally {
        if (location.hash || location.search) history.replaceState(history.state, "", location.pathname);
      }
      const booking = await client.view(access);
      setState({ kind: "ready", access, booking });
    } catch {
      setState({ kind: "unavailable" });
    }
  }
  useEffect(() => {
    void load();
  }, [id]);
  return (
    <main className="text-default mx-auto min-h-full w-full px-4 py-8">
      {state.kind !== "ready" && (
        <h1 className="text-emphasis mb-6 text-2xl font-semibold">{labels.manageBooking}</h1>
      )}
      {state.kind === "loading" && <p role="status">{labels.loading}</p>}
      {state.kind === "unavailable" && (
        <div>
          <p role="alert">{labels.statusUnavailable}</p>
          <Button onClick={() => void load()}>{labels.retry}</Button>
        </div>
      )}
      {state.kind === "ready" && (
        <BookingManagement
          access={state.access}
          booking={state.booking}
          labels={labels}
          timeFormat="h:mma"
          onUpdated={(booking) => setState({ ...state, booking })}
        />
      )}
    </main>
  );
}
