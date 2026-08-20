import { createExtractor } from "./common.js";

export const nikkeiExtractor = createExtractor({
  name: "nikkei",
  hosts: ["nikkei.com"],
  selectors: [
    "[class*='article__body']",
    ".article__body",
    "section.container .article-body",
    ".article-body",
    "#articleBody",
    "article .c-article__body",
    ".cmn-article_text",
  ],
  waitSelector: "article, [class*='article__body'], .article-body",
});
