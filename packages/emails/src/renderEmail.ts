import type { ComponentProps } from "react";
import type * as templates from "./templates";

declare global {
  interface ImportMeta {
    readonly viteRsc: {
      import: <T>(specifier: string, options: { environment: string }) => Promise<T>;
    };
  }
}

// Defined only for the RSC environment in the web app config.
declare const __CALFLARE_EMAIL_RENDERER__: "ssr" | undefined;

async function renderEmail<K extends keyof typeof templates>(
  template: K,
  props: ComponentProps<(typeof templates)[K]>
) {
  // Route handlers run in the RSC environment, where React is the server-only
  // build and react-dom/server throws. The SSR environment has the client
  // React that the renderer needs.
  if (typeof __CALFLARE_EMAIL_RENDERER__ !== "undefined" && __CALFLARE_EMAIL_RENDERER__ === "ssr") {
    const renderer = await import.meta.viteRsc.import<typeof import("./renderEmail.ssr")>(
      "./renderEmail.ssr",
      { environment: "ssr" }
    );
    return renderer.renderEmail(template, props);
  }

  const renderer = await import("./renderEmail.ssr");
  return renderer.renderEmail(template, props);
}

export default renderEmail;
