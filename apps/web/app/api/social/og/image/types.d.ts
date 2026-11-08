declare module "@calcom/web/public/app-store/svg-hashes.json" {
  const value: Record<string, string>;
  export default value;
}

// The app tsconfig reads Worker bindings through the RSC environment that
// @cloudflare/vite-plugin runs in workerd; only the binding used here is typed.
declare module "cloudflare:workers" {
  export const env: {
    ASSETS: {
      fetch(request: Request): Promise<Response>;
    };
  };
}
