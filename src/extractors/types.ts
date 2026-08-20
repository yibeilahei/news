import type { Page } from "playwright";
import type { ArticleResult } from "../models.js";

export interface SiteExtractor {
  readonly name: string;
  matches(url: URL): boolean;
  extract(page: Page): Promise<ArticleResult>;
  extractFromHtml(html: string, url: URL): Promise<ArticleResult | null>;
}
