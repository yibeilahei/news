import { createExtractor } from "./common.js";

export const itmediaExtractor = createExtractor({
  name: "itmedia",
  hosts: ["itmedia.co.jp"],
  selectors: [
    "#cmsBody",
    "div.inner-article-body",
    "#article",
    ".inner-article-body",
    ".article-body",
    "#cmsBody .inner",
  ],
  waitSelector: "#cmsBody, #article, .inner-article-body",
});
