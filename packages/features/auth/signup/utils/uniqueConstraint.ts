import { isPrismaError } from "@calcom/lib/server/getServerErrorFromUnknown";

type ConstraintMeta = {
  target?: unknown;
  driverAdapterError?: { cause?: { constraint?: { fields?: unknown } } };
};

function constraintFields(meta: unknown): string[] {
  const { target, driverAdapterError } = (meta ?? {}) as ConstraintMeta;
  return [target, driverAdapterError?.cause?.constraint?.fields]
    .flatMap((field) => (Array.isArray(field) ? field : [field]))
    .filter((field): field is string => typeof field === "string");
}

export function isUniqueEmailOrUsernameConflict(error: unknown): boolean {
  if (!isPrismaError(error) || error.code !== "P2002") return false;
  return constraintFields(error.meta).some((field) => field.includes("email") || field.includes("username"));
}
