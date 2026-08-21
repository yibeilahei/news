import { createExtractor } from "./common.js";

export const itmediaExtractor = createExtractor({
  name: "itmedia",
  hosts: ["itmedia.co.jp"],
  selectors: [
    "div.inner-article-body",
    "#cmsBody .inner-article-body",
    ".inner-article-body",
    "#cmsBody",
    ".article-body",
  ],
  waitSelector: "div.inner-article-body, #cmsBody, #article",
  removeSelectors: [".btn_list", ".sns", ".social", ".endkw", ".related", ".cmsByline"],
});
