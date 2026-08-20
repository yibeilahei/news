import { createExtractor } from "./common.js";

export const yomiuriExtractor = createExtractor({
  name: "yomiuri",
  hosts: ["yomiuri.co.jp"],
  selectors: [
    ".p-main-contents",
    ".c-article-body",
    "#article-body",
    ".c-article-content",
    "article .article-body",
    ".article-body",
  ],
  waitSelector: ".p-main-contents, .c-article-body, article",
});
