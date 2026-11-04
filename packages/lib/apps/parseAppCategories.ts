import { AppCategories } from "@calcom/prisma/enums";
import { z } from "zod";

const appCategoriesSchema = z.nativeEnum(AppCategories).array();

export function parseAppCategories<T extends { categories: unknown }>(app: T) {
  const { categories, ...rest } = app;
  return { ...rest, categories: appCategoriesSchema.parse(categories === null ? [] : categories) };
}
