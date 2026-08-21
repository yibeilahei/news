import { createExtractor } from "./common.js";

export const mainichiExtractor = createExtractor({
  name: "mainichi",
  hosts: ["mainichi.jp"],
  selectors: [
    "div.articledetail-body",
    "#main-body",
    ".main-text",
    ".articledetail-body",
    ".article-body",
  ],
  waitSelector: "#main-body, .articledetail-body, .article-body, article",
  removeSelectors: [
    ".articledetail-subcontents",
    ".articletool",
    ".articletag",
    ".ad-article-text",
    ".articlelist-item",
  ],
});
