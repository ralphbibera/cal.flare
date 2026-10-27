import type { ReactElement, SVGProps } from "react";
import { twMerge } from "tailwind-merge";
import type { IconName } from "../../../../packages/ui/components/icon/icon-names";
import sprite from "../../../web/public/icons/sprite.svg?url";

type IconProps = SVGProps<SVGSVGElement> & { name: IconName; size?: number | string };

export function Icon({ name, size = 16, className, ...props }: IconProps): ReactElement {
  return (
    <svg height={size} width={size} className={twMerge("fill-transparent", className)} {...props} aria-hidden>
      <use href={`${sprite}#${name}`} />
    </svg>
  );
}
