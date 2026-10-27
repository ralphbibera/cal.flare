import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithRef, ReactNode } from "react";
import { twMerge } from "tailwind-merge";
import type { IconName } from "../../../../packages/ui/components/icon/icon-names";
import { Icon } from "./Icon.tsx";

const buttonClasses = cva(
  "group whitespace-nowrap inline-flex items-center text-sm font-medium relative rounded-[10px] transition cursor-pointer disabled:cursor-not-allowed gap-1",
  {
    variants: {
      variant: { button: "", icon: "flex justify-center" },
      color: {
        primary:
          "bg-brand-default text-brand not-disabled:hover:bg-brand-emphasis focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-button-solid-brand-focused border border-brand-default disabled:opacity-30 shadow-button-solid-brand-default not-disabled:active:shadow-button-solid-brand-active not-disabled:hover:shadow-button-solid-brand-hover transition-shadow transition-transform duration-100",
        secondary:
          "bg-default text-default border border-default not-disabled:hover:bg-cal-muted not-disabled:hover:text-emphasis disabled:opacity-30 focus-visible:bg-subtle focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-outline-gray-focused shadow-outline-gray-rested not-disabled:hover:shadow-outline-gray-hover not-disabled:active:shadow-outline-gray-active transition-shadow duration-200",
        minimal:
          "text-subtle border border-transparent not-disabled:hover:bg-subtle not-disabled:hover:text-emphasis not-disabled:hover:border-subtle hover:border disabled:opacity-30 focus-visible:bg-subtle focus-visible:outline-none focus-visible:ring-0 focus-visible:border-subtle focus-visible:shadow-button-outline-gray-focused not-disabled:active:shadow-outline-gray-active transition-shadow duration-200",
        destructive:
          "border border-default text-error dark:hover:text-red-400 hover:border-semantic-error hover:bg-error focus-visible:text-red-700 focus-visible:bg-error focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-button-outline-red-focused disabled:bg-red-100 disabled:border-red-200 disabled:text-red-700 disabled:hover:border-red-200 disabled:opacity-30 shadow-outline-red-rested not-disabled:hover:shadow-outline-red-hover not-disabled:active:shadow-outline-red-active transition-shadow duration-200",
      },
      size: {
        xs: "h-6 p-2 leading-none text-xs rounded-md",
        sm: "h-7 px-2 py-1.5 leading-none text-sm",
        base: "px-2.5 py-2 text-sm leading-none",
        lg: "px-3 py-2.5",
      },
      loading: { true: "cursor-wait" },
    },
    compoundVariants: [
      { loading: true, color: "primary", className: "opacity-30" },
      { loading: true, color: "secondary", className: "bg-subtle text-emphasis/80" },
      { loading: true, color: "minimal", className: "bg-subtle text-emphasis/30" },
      {
        loading: true,
        color: "destructive",
        className:
          "text-red-700/30 dark:text-red-700/30 hover:text-red-700/30 border border-default text-emphasis",
      },
      { variant: "icon", size: "base", className: "min-h-[36px] min-w-[36px] p-2! hover:border-default" },
      { variant: "icon", size: "xs", className: "h-5 w-5 p-1! rounded-md" },
      { variant: "icon", size: "sm", className: "h-6 w-6 p-1! rounded-md" },
      { variant: "icon", size: "lg", className: "h-10 w-10 p-1!" },
    ],
    defaultVariants: { variant: "button", color: "primary", size: "base" },
  }
);

type ButtonProps = Omit<ComponentPropsWithRef<"button">, "color"> &
  VariantProps<typeof buttonClasses> & {
    StartIcon?: IconName;
    EndIcon?: IconName;
    CustomStartIcon?: ReactNode;
  };

function Button({
  loading = false,
  color = "primary",
  size,
  variant = "button",
  type = "button",
  StartIcon,
  EndIcon,
  CustomStartIcon,
  children,
  className,
  disabled,
  ref,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      ref={ref}
      disabled={disabled || loading || false}
      type={type}
      className={twMerge(buttonClasses({ color, size, loading, variant }), className)}>
      {CustomStartIcon ||
        (StartIcon && (
          <Icon
            data-name="start-icon"
            name={StartIcon}
            className={twMerge(
              "shrink-0",
              loading ? "invisible" : "visible",
              "button-icon group-[:not(div):active]:translate-y-[0.5px]",
              variant === "icon" && "h-4 w-4",
              variant === "button" && "h-4 w-4 stroke-[1.5px]"
            )}
          />
        ))}
      <div
        className={twMerge(
          "contents",
          loading ? "invisible" : "visible",
          "group-[:not(div):active]:translate-y-[0.5px]"
        )}>
        {children}
      </div>
      {loading && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 transform">
          <svg
            className={twMerge(
              "mx-4 h-5 w-5 animate-spin",
              color === "primary" ? "text-inverted" : "text-emphasis"
            )}
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        </div>
      )}
      {EndIcon && (
        <Icon
          name={EndIcon}
          className={twMerge(
            "shrink-0",
            loading ? "invisible" : "visible",
            "group-[:not(div):active]:translate-y-[0.5px]",
            variant === "icon" && "h-4 w-4",
            variant === "button" && "h-4 w-4 stroke-[1.5px]"
          )}
        />
      )}
    </button>
  );
}

export { Button, buttonClasses, type ButtonProps };
