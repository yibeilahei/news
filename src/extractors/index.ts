import type { SiteExtractor } from "./types.js";
import { genericExtractor } from "./generic.js";
import { nhkExtractor } from "./nhk.js";
import { sankeiExtractor } from "./sankei.js";
import { mainichiExtractor } from "./mainichi.js";
import { asahiExtractor } from "./asahi.js";
import { yomiuriExtractor } from "./yomiuri.js";
import { nikkeiExtractor } from "./nikkei.js";
import { itmediaExtractor } from "./itmedia.js";
import { impressExtractor } from "./impress.js";

export type { SiteExtractor } from "./types.js";

export const siteExtractors: SiteExtractor[] = [
  nhkExtractor,
  sankeiExtractor,
  mainichiExtractor,
  asahiExtractor,
  yomiuriExtractor,
  nikkeiExtractor,
  itmediaExtractor,
  impressExtractor,
];

export { genericExtractor };

const byName = new Map<string, SiteExtractor>([
  ...siteExtractors.map((e) => [e.name, e] as const),
  ["generic", genericExtractor],
]);

export function listExtractorNames(): string[] {
  return [...byName.keys()];
}

export function findExtractor(url: URL, preferred?: string): SiteExtractor {
  if (preferred) {
    const named = byName.get(preferred);
    if (named) return named;
  }
  return siteExtractors.find((e) => e.matches(url)) ?? genericExtractor;
}
