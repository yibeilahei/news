import { createExtractor } from "./common.js";

export const mainichiExtractor = createExtractor({
  name: "mainichi",
  hosts: ["mainichi.jp"],
  selectors: [
    "#main-body",
    ".main-text",
    "div.articledetail-body",
    ".article-body",
    "#article",
    ".articledetail-body",
    "article .body",
    ".main-contents",
  ],
  waitSelector: "#main-body, .articledetail-body, .article-body, article",
});
