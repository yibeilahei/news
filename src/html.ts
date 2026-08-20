import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import sanitizeHtml from "sanitize-html";
import type { ArticleImage, ArticleResult } from "./models.js";
import { collapseWhitespace, parseDate } from "./util.js";

export const SUBSTANTIAL_TEXT_CHARS = 1200;
export const WEAK_TEXT_CHARS = 200;

const PAYWALL_SELECTORS = [
  "[class*='paywall']",
  "[id*='paywall']",
  "[class*='Paywall']",
  "[data-paywall]",
  ".piano-paywall",
  "#piano-paywall",
  ".c-paywall",
  ".article-paywall",
  ".login-wall",
  ".subscription-wall",
  ".member-only",
  ".c-member-only",
  ".paid-member",
  ".js-paywall",
  "[class*='PaidMember']",
  "[class*='memberLimited']",
];

const PAYWALL_TEXT_RE =
  /この記事は有料|有料会員になると|有料会員限定|会員限定です|会員限定記事|続きを読むには会員|全文を読むには|ログインして全文|日経電子版の購読|定期購読すると|本文を読むには（会員|本文を読むには会員/;

const PAYWALL_FLAG_RE = /会員限定|有料記事|有料会員/;

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "code",
    "em",
    "strong",
    "b",
    "i",
    "u",
    "s",
    "br",
    "hr",
    "img",
    "figure",
    "figcaption",
    "ruby",
    "rt",
    "rp",
    "rb",
    "a",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "span",
    "div",
    "sub",
    "sup",
    "small",
    "dl",
    "dt",
    "dd",
    "section",
    "article",
    "header",
    "footer",
    "time",
  ],
  allowedAttributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title", "width", "height"],
    time: ["datetime"],
    th: ["colspan", "rowspan"],
    td: ["colspan", "rowspan"],
    ruby: [],
    rt: [],
    rp: [],
    rb: [],
    span: ["class"],
    div: ["class"],
    p: ["class"],
    h1: ["class"],
    h2: ["class"],
    h3: ["class"],
    figure: ["class"],
  },
  allowedSchemes: ["http", "https", "data"],
  allowedSchemesByTag: {
    img: ["http", "https", "data"],
    a: ["http", "https", "mailto"],
  },
  allowProtocolRelative: false,
  transformTags: {
    div: (tagName, attribs) => {
      if (attribs.class && /caption|photo|figure/i.test(attribs.class)) {
        return { tagName: "div", attribs };
      }
      return { tagName: "div", attribs };
    },
  },
};

export function parseDocument(html: string, url?: string): Document {
  const dom = new JSDOM(html, url ? { url } : undefined);
  return dom.window.document;
}

export function sanitizeArticleHtml(html: string): string {
  if (!html) return "";
  return sanitizeHtml(html, SANITIZE_OPTIONS).trim();
}

export function htmlToText(html: string): string {
  if (!html) return "";
  const doc = parseDocument(`<div id="root">${html}</div>`);
  const root = doc.getElementById("root") ?? doc.body;
  return collapseWhitespace(root?.textContent ?? "");
}

export function wrapPlainTextAsHtml(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (/<[a-z][\s\S]*>/i.test(trimmed)) return sanitizeArticleHtml(trimmed);
  return trimmed
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para.replace(/\n/g, "<br/>"))}</p>`)
    .join("\n");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function isSubstantialText(text: string, min = SUBSTANTIAL_TEXT_CHARS): boolean {
  return htmlToTextIfNeeded(text).length >= min;
}

function htmlToTextIfNeeded(value: string): string {
  if (/<[a-z][\s\S]*>/i.test(value)) return htmlToText(value);
  return collapseWhitespace(value);
}

export function isWeakText(text: string): boolean {
  return htmlToTextIfNeeded(text).length < WEAK_TEXT_CHARS;
}

export function detectPaywall(html: string, doc?: Document): boolean {
  if (!html) return false;
  const document = doc ?? parseDocument(html);
  for (const selector of PAYWALL_SELECTORS) {
    try {
      if (document.querySelector(selector)) return true;
    } catch {
      // invalid selector in this jsdom version
    }
  }
  const flags = [
    ...document.querySelectorAll(
      ".flag, .label, .badge, .kiji-pay, [class*='member'], [class*='paid'], [class*='Paid']",
    ),
  ]
    .map((el) => el.textContent ?? "")
    .join(" ");
  if (PAYWALL_FLAG_RE.test(flags) && flags.length < 400) return true;

  const banners = [
    ...document.querySelectorAll(
      "aside, .banner, .modal, .overlay, [class*='login'], [class*='subscribe']",
    ),
  ]
    .map((el) => collapseWhitespace(el.textContent ?? ""))
    .join("\n");
  if (PAYWALL_TEXT_RE.test(banners)) return true;
  if (PAYWALL_TEXT_RE.test(html.slice(0, 80_000))) return true;
  return false;
}

export function detectJsRequired(html: string, extractedTextLen: number): boolean {
  if (extractedTextLen >= 400) return false;
  if (/enable JavaScript|JavaScript を有効|JavaScriptを有効/i.test(html)) return true;
  if (/<div id="(__next|app|root)"[^>]*>\s*<\/div>/i.test(html)) return true;
  if (/id="__NEXT_DATA__"/.test(html) && extractedTextLen < 120) return true;
  if (/cf-browser-verification|just a moment/i.test(html)) return true;
  if (/<noscript>/i.test(html) && extractedTextLen < 120) return true;
  return false;
}

export function detectAccessDenied(html: string, status?: number): boolean {
  if (status === 401 || status === 403) return true;
  if (/captcha|are you a robot|hcaptcha|recaptcha/i.test(html) && html.length < 20_000) {
    return true;
  }
  if (/access denied|access is denied|アクセスが拒否/i.test(html) && html.length < 8000) {
    return true;
  }
  return false;
}

export function extractMetadata(doc: Document): {
  title?: string;
  author?: string | null;
  publishedAt?: Date | null;
  canonicalUrl?: string;
} {
  const canonical =
    doc.querySelector("link[rel='canonical']")?.getAttribute("href") ??
    doc.querySelector("meta[property='og:url']")?.getAttribute("content") ??
    undefined;
  const title =
    doc.querySelector("meta[property='og:title']")?.getAttribute("content") ??
    doc.querySelector("h1")?.textContent ??
    doc.title ??
    undefined;
  const author =
    doc.querySelector("meta[name='author']")?.getAttribute("content") ??
    doc.querySelector("meta[property='article:author']")?.getAttribute("content") ??
    doc.querySelector("[rel='author']")?.textContent ??
    doc.querySelector(".author, .byline, [class*='author']")?.textContent ??
    null;
  const publishedRaw =
    doc.querySelector("meta[property='article:published_time']")?.getAttribute("content") ??
    doc.querySelector("meta[name='pubdate']")?.getAttribute("content") ??
    doc.querySelector("time[datetime]")?.getAttribute("datetime") ??
    null;

  return {
    title: title ? collapseWhitespace(title) : undefined,
    author: author ? collapseWhitespace(author) || null : null,
    publishedAt: parseDate(publishedRaw),
    canonicalUrl: canonical ?? undefined,
  };
}

export function collectImages(html: string, baseUrl: string): ArticleImage[] {
  if (!html) return [];
  const doc = parseDocument(`<div id="root">${html}</div>`, baseUrl);
  const images: ArticleImage[] = [];
  const seen = new Set<string>();
  for (const img of doc.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (!src || src.startsWith("data:")) continue;
    let absolute: string;
    try {
      absolute = new URL(src, baseUrl).href;
    } catch {
      continue;
    }
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const figure = img.closest("figure");
    const caption = figure?.querySelector("figcaption")?.textContent;
    images.push({
      originalUrl: absolute,
      alt: img.getAttribute("alt") ?? undefined,
      caption: caption ? collapseWhitespace(caption) : undefined,
    });
  }
  return images.slice(0, 20);
}

export function extractWithReadability(html: string, url: string): ArticleResult | null {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const meta = extractMetadata(doc);
  if (detectPaywall(html, doc)) {
    return {
      html: "",
      title: meta.title,
      author: meta.author,
      publishedAt: meta.publishedAt,
      canonicalUrl: meta.canonicalUrl,
      paywalled: true,
      inaccessible: true,
    };
  }
  let parsed: ReturnType<Readability["parse"]> = null;
  try {
    parsed = new Readability(doc).parse();
  } catch {
    parsed = null;
  }
  if (!parsed?.content) return null;
  const sanitized = sanitizeArticleHtml(parsed.content);
  const text = htmlToText(sanitized);
  if (!text) return null;
  return {
    title: parsed.title || meta.title,
    html: sanitized,
    text,
    author: parsed.byline || meta.author,
    publishedAt: meta.publishedAt,
    canonicalUrl: meta.canonicalUrl,
    images: collectImages(sanitized, url),
    paywalled: false,
    inaccessible: false,
  };
}

export function extractBySelectors(
  html: string,
  url: string,
  selectors: string[],
): ArticleResult | null {
  const doc = parseDocument(html, url);
  const meta = extractMetadata(doc);
  if (detectPaywall(html, doc)) {
    return {
      html: "",
      title: meta.title,
      author: meta.author,
      publishedAt: meta.publishedAt,
      canonicalUrl: meta.canonicalUrl,
      paywalled: true,
      inaccessible: true,
    };
  }
  const parts: string[] = [];
  for (const selector of selectors) {
    try {
      const matches = [...doc.querySelectorAll(selector)];
      for (const el of matches) {
        const inner = (el as HTMLElement).innerHTML?.trim();
        if (inner) parts.push(inner);
      }
    } catch {
      // ignore bad selectors
    }
  }
  if (parts.length === 0) return null;
  const combined = parts.join("\n");
  const sanitized = sanitizeArticleHtml(combined);
  const text = htmlToText(sanitized);
  if (text.length < WEAK_TEXT_CHARS) return null;
  return {
    title: meta.title,
    html: sanitized,
    text,
    author: meta.author,
    publishedAt: meta.publishedAt,
    canonicalUrl: meta.canonicalUrl,
    images: collectImages(sanitized, url),
    paywalled: false,
    inaccessible: false,
  };
}

export function finalizeResult(result: ArticleResult, url: string): ArticleResult {
  const html = sanitizeArticleHtml(result.html);
  const text = result.text && result.text.length > 0 ? collapseWhitespace(result.text) : htmlToText(html);
  return {
    ...result,
    html,
    text,
    images: result.images && result.images.length > 0 ? result.images : collectImages(html, url),
  };
}

export function rssSummaryToHtml(summary: string | null | undefined): string {
  if (!summary) return "";
  const trimmed = summary.trim();
  if (!trimmed) return "";
  if (/<[a-z][\s\S]*>/i.test(trimmed)) return sanitizeArticleHtml(trimmed);
  return wrapPlainTextAsHtml(trimmed);
}
