import type { ComponentPropsWithRef } from "react";
import { twMerge } from "tailwind-merge";

export function Label({ className, ...props }: ComponentPropsWithRef<"label">) {
  return (
    <label
      className={twMerge("text-default text-emphasis mb-2 block text-sm font-medium leading-none", className)}
      {...props}
    />
  );
}
