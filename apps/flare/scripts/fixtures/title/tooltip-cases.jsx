import { Provider } from "@radix-ui/react-tooltip";

export function TooltipCases({ Tooltip }) {
  const params = new URLSearchParams(location.search);
  const side = params.get("side") || undefined;
  const mode = params.get("mode") || "static";
  return (
    <Provider>
      <main className="mx-auto flex min-h-[640px] w-full max-w-sm items-center justify-center gap-3 rounded-xl border border-default bg-default p-6 text-default">
        {mode === "empty" ? (
          [undefined, null, ""].map((content, index) => (
            <Tooltip key={index} content={content}>
              <span data-testid="empty-child">Empty</span>
            </Tooltip>
          ))
        ) : (
          <Tooltip
            content="February"
            side={side}
            open={mode === "static" ? true : mode === "closed" ? false : undefined}
            className={side === "bottom" ? "bg-red-600 px-4 text-base font-normal" : undefined}
            data-testid="tooltip-content">
            {side === "left" ? (
              "View next month"
            ) : (
              <button type="button" className="h-9 rounded-md border border-default px-3 text-sm">
                View next month
              </button>
            )}
          </Tooltip>
        )}
      </main>
    </Provider>
  );
}
