import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

type Props = { children: ReactNode; className?: string; ariaLabel?: string };

export function ScrollableWithGradients({ children, className, ariaLabel }: Props) {
  const [gradients, setGradients] = useState({ top: false, bottom: false });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const updateGradients = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const { scrollTop, scrollHeight, clientHeight } = node;
    const top = scrollTop > 5;
    const bottom = scrollTop + clientHeight < scrollHeight - 5;
    setGradients((previous) =>
      previous.top === top && previous.bottom === bottom ? previous : { top, bottom }
    );
  }, []);
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      updateGradients();
    },
    [updateGradients]
  );
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const observer = new ResizeObserver(updateGradients);
    observer.observe(node);
    return () => observer.disconnect();
  }, [updateGradients]);
  return (
    <div className="relative">
      <div
        ref={setRef}
        onScroll={updateGradients}
        className={className}
        tabIndex={0}
        role="region"
        aria-label={ariaLabel}>
        {children}
      </div>
      {gradients.top && (
        <div
          className="from-default pointer-events-none absolute left-0 right-0 top-0 h-8 bg-gradient-to-b to-transparent dark:from-[var(--cal-bg-muted)]"
          aria-hidden="true"
        />
      )}
      {gradients.bottom && (
        <div
          className="from-default pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t to-transparent dark:from-[var(--cal-bg-muted)]"
          aria-hidden="true"
        />
      )}
    </div>
  );
}
