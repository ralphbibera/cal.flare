import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

const mobileQuery = "(max-width: 768px)";
function subscribe(onChange: () => void) {
  const media = matchMedia(mobileQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function BookingFormDialog({
  children,
  active,
  heading,
  locked,
  onBack,
}: {
  children: ReactNode;
  active: boolean;
  heading: string;
  locked: boolean;
  onBack: () => void;
}) {
  const mobile = useSyncExternalStore(
    subscribe,
    () => matchMedia(mobileQuery).matches,
    () => false
  );
  const modal = active && mobile;
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    if (!modal) return;
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, [modal]);
  if (!modal) return <section className="border-subtle p-6 md:col-span-2 md:border-l">{children}</section>;
  return (
    <dialog
      ref={dialog}
      aria-labelledby="booking-dialog-title"
      className="bg-default text-default scroll-bar m-auto max-h-[80vh] w-[95vw] max-w-none overflow-y-auto rounded-2xl border-0 p-8 text-left shadow-xl sm:max-w-140 backdrop:bg-neutral-800/70"
      onCancel={(event) => {
        event.preventDefault();
        if (!locked) onBack();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || locked) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onBack();
      }}>
      <h1 id="booking-dialog-title" className="font-cal text-emphasis mb-4 text-xl leading-5">
        {heading}
      </h1>
      {children}
    </dialog>
  );
}
