import { Children, type ComponentProps, type HTMLAttributes, type ReactNode } from "react";
import { twMerge } from "tailwind-merge";
import { Icon } from "./Icon.tsx";

type Props = HTMLAttributes<HTMLDivElement> & {
  customIcon?: ReactNode;
  icon?: ComponentProps<typeof Icon>["name"];
  iconUrl?: string;
  highlight?: boolean;
  contentClassName?: string;
  isDark?: boolean;
};

export function EventMetaBlock({
  customIcon,
  icon,
  iconUrl,
  children,
  highlight,
  contentClassName,
  className,
  isDark,
  ...props
}: Props) {
  if (!Children.count(children)) return null;
  return (
    <div
      className={twMerge(
        "flex items-start justify-start text-sm",
        highlight ? "text-emphasis" : "text-text",
        className
      )}
      {...props}>
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          className={twMerge(
            "mr-2 mt-[2px] h-4 w-4 shrink-0",
            isDark === undefined && "filter-[invert(0.5)_brightness(0.5)]",
            (isDark === undefined || isDark) && "dark:filter-[invert(0.65)_brightness(0.9)]"
          )}
        />
      ) : (
        customIcon ||
        (!!icon && <Icon name={icon} className="relative z-20 mr-2 mt-[2px] h-4 w-4 shrink-0 rtl:ml-2" />)
      )}
      <div className={twMerge("relative z-10 max-w-full wrap-break-word", contentClassName)}>{children}</div>
    </div>
  );
}
