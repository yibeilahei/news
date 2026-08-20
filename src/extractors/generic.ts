import type { Page } from "playwright";
import type { ArticleResult } from "../models.js";
import { emptyArticleResult } from "../models.js";
import { extractWithReadability, finalizeResult } from "../html.js";
import type { SiteExtractor } from "./types.js";

export const genericExtractor: SiteExtractor = {
  name: "generic",
  matches(_url: URL): boolean {
    return true;
  },
  async extractFromHtml(html: string, url: URL): Promise<ArticleResult | null> {
    const result = extractWithReadability(html, url.href);
    if (!result) return null;
    return finalizeResult(result, url.href);
  },
  async extract(page: Page): Promise<ArticleResult> {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page
      .waitForSelector("article, main, [role='main'], .article, #article", { timeout: 8000 })
      .catch(() => undefined);
    const html = await page.content();
    const url = new URL(page.url());
    const result = await this.extractFromHtml(html, url);
    return result ?? emptyArticleResult({ inaccessible: true });
  },
};
