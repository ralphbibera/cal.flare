import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { isValidElement, type ReactNode } from "react";
import { twMerge } from "tailwind-merge";

type TooltipProps = Omit<TooltipPrimitive.TooltipContentProps, "content"> & {
  children: ReactNode;
  content: ReactNode;
  delayDuration?: number;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function Tooltip({
  children,
  content,
  open,
  defaultOpen,
  onOpenChange,
  delayDuration,
  side = "top",
  ...props
}: TooltipProps) {
  if (content === undefined || content === null || content === "") return <>{children}</>;
  const trigger = isValidElement(children) ? children : <span>{children}</span>;
  return (
    <TooltipPrimitive.Root
      delayDuration={delayDuration || 50}
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}>
      <TooltipPrimitive.Trigger asChild>{trigger}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          {...props}
          className={twMerge(
            "calcom-tooltip",
            side === "top" && "-mt-7",
            side === "left" && "mr-2",
            side === "right" && "ml-2",
            "bg-inverted text-inverted relative z-50 rounded-sm px-2 py-1 text-xs font-semibold shadow-lg",
            props.className
          )}
          side={side}
          align="center">
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export { Tooltip, type TooltipProps };
