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
  summary,
  locked,
  onBack,
  forceModal = false,
}: {
  children: ReactNode;
  active: boolean;
  heading: string;
  summary?: ReactNode;
  locked: boolean;
  onBack: () => void;
  forceModal?: boolean;
}) {
  const mobile = useSyncExternalStore(
    subscribe,
    () => matchMedia(mobileQuery).matches,
    () => false
  );
  const modal = active && (mobile || forceModal);
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    if (!modal) return;
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, [modal]);
  if (!modal)
    return (
      <section
        className={
          active
            ? "border-subtle sticky top-0 h-full p-6 min-[769px]:-ml-px min-[769px]:w-[var(--booker-main-width)] min-[769px]:border-l"
            : "border-subtle p-6 md:col-span-2 md:border-l"
        }>
        {children}
      </section>
    );
  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      aria-labelledby="booking-dialog-title"
      className="scroll-bar fixed top-1/2 right-auto bottom-auto left-1/2 m-auto max-h-[80vh] w-[95vw] max-w-none -translate-x-1/2 -translate-y-1/2 overflow-y-auto scroll-pb-[65px] rounded-2xl border-0 bg-default p-8 pb-0 text-left text-default shadow-xl backdrop:bg-neutral-800/70 sm:max-w-140 [&_form]:contents [&_.modalsticky]:sticky [&_.modalsticky]:right-0 [&_.modalsticky]:bottom-0 [&_.modalsticky]:left-0 [&_.modalsticky]:-mx-8 [&_.modalsticky]:border-t [&_.modalsticky]:border-t-subtle [&_.modalsticky]:bg-default [&_.modalsticky]:px-8 [&_.modalsticky]:py-4"
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
      <h1 id="booking-dialog-title" className="font-cal text-emphasis text-xl leading-5">
        {heading}
      </h1>
      {summary}
      {children}
    </dialog>
  );
}
