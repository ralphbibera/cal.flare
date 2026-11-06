"use client";

import { SessionProvider } from "@calcom/features/auth/client";
import { NotificationSoundHandler } from "@calcom/web/components/notification-sound-handler";
import { WebPushProvider } from "@calcom/web/modules/notifications/components/WebPushContext";
import { ToastProvider } from "@coss/ui/components/toast";
import useIsBookingPage from "@lib/hooks/useIsBookingPage";
import { TrpcProvider } from "app/_trpc/trpc-provider";
import CacheProvider from "react-inlinesvg/provider";
import { GeoProvider } from "./GeoContext";

type ProvidersProps = {
  isEmbed: boolean;
  children: React.ReactNode;
  nonce: string | undefined;
  country: string;
};
export function Providers({ isEmbed, children, country }: ProvidersProps) {
  const isBookingPage = useIsBookingPage();

  return (
    <GeoProvider country={country}>
      <SessionProvider>
        <TrpcProvider>
          <ToastProvider position="bottom-center">
            {!isEmbed && !isBookingPage && <NotificationSoundHandler />}
            <CacheProvider>
              <WebPushProvider>{children}</WebPushProvider>
            </CacheProvider>
          </ToastProvider>
        </TrpcProvider>
      </SessionProvider>
    </GeoProvider>
  );
}
