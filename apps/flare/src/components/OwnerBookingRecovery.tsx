import { useEffect, useState } from "react";
import { Button } from "./Button.tsx";

export function OwnerBookingRecovery({
  id,
  labels,
}: {
  id: string;
  labels: { retry: string; failed: string; javascript: string };
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "working" | "failed">("loading");
  useEffect(() => setStatus("ready"), []);
  return (
    <div className="mt-3">
      <Button
        color="secondary"
        disabled={status === "loading"}
        loading={status === "working"}
        onClick={async () => {
          setStatus("working");
          try {
            const response = await fetch("/api/owner/retry", {
              method: "POST",
              credentials: "same-origin",
              cache: "no-store",
              redirect: "error",
              signal: AbortSignal.timeout(30_000),
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id }),
            });
            await response.body?.cancel();
            if (response.status !== 200 && response.status !== 202) throw new Error();
            window.location.reload();
          } catch {
            setStatus("failed");
          }
        }}>
        {labels.retry}
      </Button>
      {status === "failed" && (
        <p className="mt-2" role="alert">
          {labels.failed}
        </p>
      )}
      <noscript>
        <p className="mt-2">{labels.javascript}</p>
      </noscript>
    </div>
  );
}
