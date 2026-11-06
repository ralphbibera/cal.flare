import type { IncomingMessage } from "node:http";
import { SessionProvider } from "@calcom/features/auth/client";
import { trpc } from "@calcom/trpc/react";
import { WebPushProvider } from "@calcom/web/modules/notifications/components/WebPushContext";
import type { AppProps } from "@lib/app-providers";
import type { NextPageContext } from "next";
import CacheProvider from "react-inlinesvg/provider";

import "../styles/globals.css";

function MyApp(props: AppProps) {
  const { Component, pageProps } = props;

  return (
    <SessionProvider session={pageProps.session ?? undefined}>
      <WebPushProvider>
        <CacheProvider>
          {Component.PageWrapper ? <Component.PageWrapper {...props} /> : <Component {...pageProps} />}
        </CacheProvider>
      </WebPushProvider>
    </SessionProvider>
  );
}

declare global {
  interface Window {
    calNewLocale: string;
  }
}

MyApp.getInitialProps = async ({ ctx }: { ctx: NextPageContext }) => {
  const { req } = ctx;

  let newLocale = "en";

  // The SSR flag is replaced at build time, so the client bundle drops this branch and never reaches the
  // server session readers (and the D1 Prisma client) that getLocale imports.
  if (import.meta.env.SSR && req) {
    const { getLocale } = await import("@calcom/features/auth/lib/getLocale");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    newLocale = await getLocale(req as IncomingMessage & { cookies: Record<string, any> });
  } else if (typeof window !== "undefined" && window.calNewLocale) {
    newLocale = window.calNewLocale;
  }

  return {
    pageProps: {
      newLocale,
    },
  };
};

const WrappedMyApp = trpc.withTRPC(MyApp);

export default WrappedMyApp;
