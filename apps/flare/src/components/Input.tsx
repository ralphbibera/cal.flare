import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithRef } from "react";
import { twMerge } from "tailwind-merge";

const inputStyles = cva(
  [
    "rounded-[10px] border",
    "leading-none font-normal",
    "bg-default",
    "border-default",
    "text-default",
    "placeholder:text-muted",
    "hover:border-emphasis",
    "focus:border-emphasis",
    "focus:ring-0",
    "focus:shadow-outline-gray-focused",
    "disabled:bg-subtle",
    "disabled:hover:border-default",
    "disabled:cursor-not-allowed",
    "shadow-outline-gray-rested",
    "transition-all",
  ],
  {
    variants: { size: { sm: "h-7 px-2 py-1 text-xs", md: "h-8 px-3 py-2 text-sm" } },
    defaultVariants: { size: "md" },
  }
);
type InputProps = Omit<ComponentPropsWithRef<"input">, "size"> &
  VariantProps<typeof inputStyles> & { isFullWidth?: boolean };

function Input({ isFullWidth = true, size = "md", className, ...props }: InputProps) {
  return (
    <input {...props} className={twMerge(inputStyles({ size }), isFullWidth ? "w-full" : "", className)} />
  );
}

export { Input, inputStyles, type InputProps };
