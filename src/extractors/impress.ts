import { createExtractor } from "./common.js";

export const impressExtractor = createExtractor({
  name: "impress",
  hosts: ["impress.co.jp"],
  selectors: [
    "#article",
    ".article-body",
    "#main-contents .body",
    "#main-contents",
    "div#body",
    "article .body",
  ],
  waitSelector: "#article, .article-body, #main-contents",
});
