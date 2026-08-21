import { createExtractor } from "./common.js";

export const nhkExtractor = createExtractor({
  name: "nhk",
  hosts: ["nhk.or.jp"],
  selectors: [
    "#news_textbody",
    "#news_textmore",
    ".content--detail-body",
    ".content--body",
    "[class*='DetailBody']",
    "article .content",
    "#newsarticle",
  ],
  waitSelector: "#news_textbody, .content--detail-body, #newsarticle, article",
  removeSelectors: [".content--related", ".related-news", ".c-related"],
});
