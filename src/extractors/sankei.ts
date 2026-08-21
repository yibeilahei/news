import { createExtractor } from "./common.js";

export const sankeiExtractor = createExtractor({
  name: "sankei",
  hosts: ["sankei.com", "sankei.jp"],
  selectors: [
    "article .article-body",
    ".article-body",
    ".article-text",
    "[class*='article-body']",
    "[data-article-body]",
    "article .body",
    ".article__body",
  ],
  waitSelector: "article, .article-body, [class*='article-body']",
  removeSelectors: [".related-article", ".c-related", ".article-share"],
});
