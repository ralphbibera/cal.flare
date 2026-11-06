import { getAppRegistry } from "@calcom/app-store/_appRegistry";
import { D1AppRepository } from "@calcom/features/apps/repository/D1AppRepository";
import type { AppCategories } from "@calcom/prisma/enums";

export type CategoryDataProps = NonNullable<Awaited<ReturnType<typeof getStaticProps>>>;

export const getStaticProps = async (category: AppCategories) => {
  const appQuery = await D1AppRepository.findEnabledSlugsByCategory(category);

  const dbAppsSlugs = appQuery.map((category) => category.slug);

  const appStore = await getAppRegistry();

  const apps = appStore.filter((app) => dbAppsSlugs.includes(app.slug));
  return {
    apps,
    category,
  };
};
