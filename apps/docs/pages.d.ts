declare module "virtual:docs" {
  import type { EvaluateResult, PageMapItem } from "nextra";
  export function getPageMap(): Promise<PageMapItem[]>;
  export function generateStaticParamsFor<Key extends string>(key: Key): () => Promise<Record<Key, string[]>[]>;
  export function importPage(segments?: string[]): Promise<EvaluateResult>;
}
