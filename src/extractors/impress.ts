import { createExtractor } from "./common.js";

export const impressExtractor = createExtractor({
  name: "impress",
  hosts: ["impress.co.jp"],
  selectors: [
    "div#body",
    "#main-contents div#body",
    "#article .article-body",
    ".article-body",
    "#main-contents .article",
    "#article",
  ],
  waitSelector: "div#body, .article-body, #article, #main-contents",
  removeSelectors: [
    ".ranking-content",
    ".ranking-list",
    ".related-article",
    "#extra",
    ".ipw-recommend",
  ],
});
