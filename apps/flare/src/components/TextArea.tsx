import type { ComponentPropsWithRef } from "react";
import { twMerge } from "tailwind-merge";
import { inputStyles } from "./Input.tsx";

export function TextArea({ className, ...props }: ComponentPropsWithRef<"textarea">) {
  return <textarea {...props} className={twMerge(inputStyles(), "min-h-[80px] w-full", className)} />;
}
