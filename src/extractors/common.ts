import type { Page } from "playwright";
import type { ArticleResult } from "../models.js";
import { emptyArticleResult } from "../models.js";
import { extractBySelectors, extractWithReadability, finalizeResult } from "../html.js";
import type { SiteExtractor } from "./types.js";

export function hostMatches(url: URL, suffixes: string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return suffixes.some((s) => host === s || host.endsWith(`.${s}`));
}

export function createExtractor(opts: {
  name: string;
  hosts: string[];
  selectors: string[];
  waitSelector?: string;
  removeSelectors?: string[];
}): SiteExtractor {
  return {
    name: opts.name,
    matches(url: URL): boolean {
      return hostMatches(url, opts.hosts);
    },
    async extractFromHtml(html: string, url: URL): Promise<ArticleResult | null> {
      const selected = extractBySelectors(html, url.href, opts.selectors, {
        removeSelectors: opts.removeSelectors,
      });
      if (selected) return finalizeResult(selected, url.href);
      const readable = extractWithReadability(html, url.href);
      if (readable) return finalizeResult(readable, url.href);
      return null;
    },
    async extract(page: Page): Promise<ArticleResult> {
      const waitFor = opts.waitSelector ?? opts.selectors[0];
      if (waitFor) {
        await page.waitForSelector(waitFor, { timeout: 8000 }).catch(() => undefined);
      }
      const html = await page.content();
      const url = new URL(page.url());
      const result = await this.extractFromHtml(html, url);
      return result ?? emptyArticleResult({ inaccessible: true });
    },
  };
}
