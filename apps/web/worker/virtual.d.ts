declare module "virtual:calflare-static-assets" {
  const manifest: Readonly<Record<string, import("./static-assets").SplitStaticAsset>>;
  export default manifest;
}
