import { createExtractor } from "./common.js";

export const nhkExtractor = createExtractor({
  name: "nhk",
  hosts: ["nhk.or.jp"],
  selectors: [
    "#news_textbody",
    "#news_textmore",
    ".content--detail-body",
    ".content--body",
    ".content--summary",
    "#newsarticle",
    ".article-main",
    "article .content",
  ],
  waitSelector: "#news_textbody, .content--detail-body, #newsarticle, article",
});
