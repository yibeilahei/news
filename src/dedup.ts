import type { Article } from "./models.js";
import { nfkc, collapseWhitespace, formatIsoDate } from "./util.js";

const TRACKING_PARAM =
  /^(utm_|fbclid$|gclid$|yclid$|ncid$|ref$|from$|cmpid$|ito$|amp$|feature$|ncidsp$|cid$|icid$|mkt_tok$|mc_cid$|mc_eid$)/i;

export function normalizeUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return input.trim();
  }
  url.hash = "";
  if (url.protocol === "http:") url.protocol = "https:";

  let host = url.hostname.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);
  if (host.startsWith("m.") && host.split(".").length > 2) host = host.slice(2);
  url.hostname = host;

  const kept = new URLSearchParams();
  url.searchParams.forEach((value, key) => {
    if (TRACKING_PARAM.test(key)) return;
    kept.append(key, value);
  });
  url.search = kept.toString();

  let pathname = url.pathname.replace(/;jsessionid=[^/]*/i, "");
  pathname = pathname.replace(/\/amp\/?$/i, "/");
  pathname = pathname.replace(/\/amp\.html$/i, ".html");
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  url.pathname = pathname;
  return url.toString();
}

export function normalizeTitle(title: string): string {
  return collapseWhitespace(nfkc(title)).toLowerCase();
}

export function titleSourceKey(title: string, source: string, dateIso: string | null): string {
  return `${normalizeTitle(title)}::${nfkc(source).toLowerCase()}::${dateIso ?? ""}`;
}

export class Deduper {
  private readonly byCanonical = new Map<string, Article>();
  private readonly byNormalized = new Map<string, Article>();
  private readonly byTitleSource = new Map<string, Article>();

  has(article: {
    canonicalUrl: string;
    normalizedUrl: string;
    title: string;
    source: string;
    publishedAt: Date | null;
  }): Article | null {
    const canonical = this.byCanonical.get(article.canonicalUrl);
    if (canonical) return canonical;
    const normalized = this.byNormalized.get(article.normalizedUrl);
    if (normalized) return normalized;
    const key = titleSourceKey(
      article.title,
      article.source,
      article.publishedAt ? formatIsoDate(article.publishedAt) : null,
    );
    return this.byTitleSource.get(key) ?? null;
  }

  add(article: Article): void {
    this.byCanonical.set(article.canonicalUrl, article);
    this.byNormalized.set(article.normalizedUrl, article);
    this.byTitleSource.set(
      titleSourceKey(
        article.title,
        article.source,
        article.publishedAt ? formatIsoDate(article.publishedAt) : null,
      ),
      article,
    );
  }

  get size(): number {
    return this.byCanonical.size;
  }
}
