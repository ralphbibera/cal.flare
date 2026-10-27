import type { ReactElement, ReactNode } from "react";
import { twMerge } from "tailwind-merge";

interface EventTitleProps {
  children: ReactNode;
  as?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "span";
  className?: string;
}

export function EventTitle({ children, as = "h1", className }: EventTitleProps): ReactElement {
  const Element = as;
  return (
    <Element
      data-testid="event-title"
      className={twMerge("break-words font-semibold text-text text-xl", className)}>
      {children}
    </Element>
  );
}
