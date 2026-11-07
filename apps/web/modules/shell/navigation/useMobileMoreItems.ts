import { authClient } from "@calcom/features/auth/client/auth-client";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { useBottomNavItems } from "../useBottomNavItems";
import type { NavigationItemType } from "./NavigationItem";

export function useMobileMoreItems(): NavigationItemType[] {
  const { data: session } = authClient.useSession();
  const user = session?.user;
  const publicPageUrl = `${WEBAPP_URL}/${user?.orgAwareUsername ?? user?.username}`;

  const bottomNavItems = useBottomNavItems({
    publicPageUrl,
  });

  const filteredBottomNavItems = bottomNavItems.filter(
    (item: NavigationItemType) => item.name !== "settings"
  );
  return filteredBottomNavItems;
}
