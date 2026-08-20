import { createExtractor } from "./common.js";

export const asahiExtractor = createExtractor({
  name: "asahi",
  hosts: ["asahi.com"],
  selectors: [
    ".nfArticleText",
    "#articleText",
    ".ArticleText",
    ".body-text",
    ".nfArticle .nfArticleText",
    "article .text",
    ".ArticleBody",
    "#main .BodyText",
  ],
  waitSelector: ".nfArticleText, #articleText, .ArticleText, article",
});
