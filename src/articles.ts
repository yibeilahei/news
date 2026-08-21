import type {
  AppConfig,
  Article,
  ExtractionStatus,
  FeedConfig,
  FeedItem,
  RunStats,
} from "./models.js";
import { emptyStats } from "./models.js";
import type { ArticleCache } from "./cache.js";
import { Deduper, normalizeTitle, normalizeUrl, titleSourceKey } from "./dedup.js";
import { extractArticle, PlaywrightSession } from "./extractor.js";
import { fetchFeedItems, limitFeedItems } from "./feeds.js";
import {
  htmlToText,
  isSubstantialText,
  rssSummaryToHtml,
  WEAK_TEXT_CHARS,
} from "./html.js";
import type { HttpClient } from "./http.js";
import { HttpError } from "./http.js";
import { log } from "./log.js";
import { formatIsoDate, hashId, mapLimit, Semaphore, todayIso } from "./util.js";

export interface UpdateOptions {
  date: string;
  feed?: string;
  category?: string;
  maxArticles?: number;
  playwrightEnabled?: boolean;
  fromCache?: boolean;
  concurrency?: number;
  feedConcurrency?: number;
}

export async function collectArticles(
  config: AppConfig,
  cache: ArticleCache,
  http: HttpClient,
  options: UpdateOptions,
): Promise<{ articles: Article[]; stats: RunStats }> {
  const stats = emptyStats();
  const date = options.date;
  const timezone = config.timezone;
  const isToday = date === todayIso(timezone);

  if (options.fromCache || !isToday) {
    const articles = filterArticles(cache.listForDate(date, timezone), options);
    stats.discovered = articles.length;
    for (const a of articles) tally(stats, a.extractionStatus, a);
    stats.cached = articles.length;
    return { articles, stats };
  }

  const feeds = config.feeds.filter((f) => {
    if (!f.enabled) return false;
    if (options.feed && f.name !== options.feed) return false;
    if (options.category && f.category !== options.category) return false;
    return true;
  });

  if (feeds.length === 0) {
    log.warn("feeds.none_enabled");
  }

  const playwright =
    (options.playwrightEnabled ?? config.playwright.enabled)
      ? new PlaywrightSession({
          enabled: true,
          headless: config.playwright.headless,
          storageState: config.playwright.storageState,
          userAgent: config.userAgent,
        })
      : null;

  const deduper = new Deduper();
  const collected: Article[] = [];
  const articleConcurrency = options.concurrency ?? config.concurrency;
  const feedConcurrency = options.feedConcurrency ?? config.feedConcurrency;
  const articleGate = new Semaphore(articleConcurrency);
  log.info("update.concurrency", {
    articles: articleConcurrency,
    feeds: feedConcurrency,
    rateLimitMs: config.rateLimitMs,
  });

  try {
    await mapLimit(feeds, feedConcurrency, async (feed) => {
      try {
        const timeout = feed.timeoutMs ?? config.timeoutMs;
        const rawItems = await fetchFeedItems(feed, http, timeout);
        const max = options.maxArticles ?? feed.maxArticles ?? config.maxArticlesPerFeed;
        const items = limitFeedItems(rawItems, max);
        stats.feedsSuccessful += 1;
        stats.discovered += items.length;
        log.info("feed.ok", { name: feed.name, items: items.length });
        log.info("extract.start", { name: feed.name, items: items.length });

        let done = 0;
        const processed = await mapLimit(items, articleConcurrency, async (item) => {
          return articleGate.run(async () => {
            try {
              const article = await processItem({
                item,
                feed,
                config,
                cache,
                http,
                playwright,
                deduper,
                date,
                stats,
              });
              done += 1;
              log.info("extract.progress", {
                feed: feed.name,
                done,
                total: items.length,
                status: article?.extractionStatus ?? "failed",
                title: (article?.title ?? item.title).slice(0, 80),
              });
              return article;
            } catch (err) {
              done += 1;
              log.warn("article.failed", {
                feed: feed.name,
                done,
                total: items.length,
                url: item.url,
                error: err instanceof Error ? err.message : String(err),
              });
              stats.failed += 1;
              return null;
            }
          });
        });

        for (const article of processed) {
          if (!article) continue;
          collected.push(article);
          cache.upsert(article);
        }
        log.info("extract.done", { name: feed.name, items: items.length });
      } catch (err) {
        stats.feedsFailed += 1;
        const message = err instanceof Error ? err.message : String(err);
        stats.feedErrors.push({ name: feed.name, error: message });
        log.error("feed.failed", { name: feed.name, error: message });
        if (err instanceof HttpError && err.status === 451) {
          log.warn("feed.robots_blocked", { name: feed.name, url: feed.url });
        }
      }
    });
  } finally {
    await playwright?.close();
  }

  const fromCache = filterArticles(cache.listForDate(date, timezone), options);
  const merged = mergePreferFresh(fromCache, collected);
  for (const a of merged) tally(stats, a.extractionStatus, a);
  return { articles: merged, stats };
}

function mergePreferFresh(cached: Article[], fresh: Article[]): Article[] {
  const map = new Map<string, Article>();
  for (const a of cached) map.set(a.id, a);
  for (const a of fresh) map.set(a.id, a);
  return [...map.values()].sort((a, b) => {
    const src = a.source.localeCompare(b.source, "ja");
    if (src !== 0) return src;
    const ta = a.publishedAt?.getTime() ?? 0;
    const tb = b.publishedAt?.getTime() ?? 0;
    return ta - tb;
  });
}

function filterArticles(articles: Article[], options: UpdateOptions): Article[] {
  return articles.filter((a) => {
    if (options.feed && a.source !== options.feed) return false;
    if (options.category && a.category !== options.category) return false;
    return true;
  });
}

function tally(stats: RunStats, status: ExtractionStatus, article: Article): void {
  switch (status) {
    case "full":
    case "cached":
      stats.full += 1;
      if (status === "cached") stats.cached += 1;
      break;
    case "rss_only":
      stats.rssOnly += 1;
      break;
    case "paywalled":
      stats.paywalled += 1;
      break;
    case "inaccessible":
      stats.inaccessible += 1;
      break;
    case "duplicate":
      stats.duplicates += 1;
      break;
    case "failed":
      stats.failed += 1;
      break;
    case "skipped_robots":
      stats.skippedRobots += 1;
      break;
    default:
      break;
  }
  if (article.paywalled && status !== "paywalled") stats.paywalled += 1;
}

interface ProcessCtx {
  item: FeedItem;
  feed: FeedConfig;
  config: AppConfig;
  cache: ArticleCache;
  http: HttpClient;
  playwright: PlaywrightSession | null;
  deduper: Deduper;
  date: string;
  stats: RunStats;
}

async function processItem(ctx: ProcessCtx): Promise<Article | null> {
  const { item, feed, config, cache, http, playwright, deduper } = ctx;
  const normalizedUrl = normalizeUrl(item.url);
  const canonicalGuess = normalizedUrl;

  const seen = deduper.has({
    canonicalUrl: canonicalGuess,
    normalizedUrl,
    title: item.title,
    source: feed.name,
    publishedAt: item.publishedAt,
  });
  if (seen) {
    log.debug("article.duplicate", { url: item.url, of: seen.url });
    ctx.stats.duplicates += 1;
    return null;
  }

  const cached = cache.getByUrlKeys(canonicalGuess, normalizedUrl);
  if (cached && !shouldRefresh(cached)) {
    deduper.add(cached);
    return { ...cached, extractionStatus: cached.extractionStatus === "full" ? "cached" : cached.extractionStatus };
  }

  const rssHtml = item.summaryHtml ?? "";
  const rssText = item.summaryText ?? (rssHtml ? htmlToText(rssHtml) : "");
  const strategy = feed.extraction ?? "auto";
  const now = new Date();

  let html = "";
  let text = "";
  let author = item.author;
  let publishedAt = item.publishedAt;
  let canonicalUrl = canonicalGuess;
  let paywalled = false;
  let inaccessible = false;
  let status: ExtractionStatus = "rss_only";
  let images = cached?.images ?? [];

  const rssIsFull = isSubstantialText(rssText) && strategy !== "http" && strategy !== "playwright";

  if (rssIsFull) {
    html = rssHtml;
    text = rssText;
    status = "full";
  } else if (strategy !== "rss-only") {
    const robots = await http.isAllowed(item.url);
    if (!robots.allowed) {
      html = rssHtml;
      text = rssText;
      status = rssText ? "rss_only" : "skipped_robots";
      inaccessible = !rssText;
    } else {
      const extracted = await extractArticle(item.url, {
        http,
        timeoutMs: feed.timeoutMs ?? config.timeoutMs,
        strategy,
        extractorName: feed.extractor,
        playwright,
      });
      paywalled = extracted.paywalled;
      inaccessible = extracted.inaccessible || extracted.paywalled;
      if (extracted.canonicalUrl) {
        try {
          canonicalUrl = normalizeUrl(extracted.canonicalUrl);
        } catch {
          canonicalUrl = extracted.canonicalUrl;
        }
      }
      if (extracted.author) author = extracted.author;
      if (extracted.publishedAt) publishedAt = extracted.publishedAt;
      if (extracted.images) images = extracted.images;

      if (extracted.paywalled || extracted.inaccessible) {
        html = rssHtml;
        text = rssText;
        status = extracted.paywalled ? "paywalled" : rssText ? "rss_only" : "inaccessible";
      } else if (extracted.html && htmlToText(extracted.html).length >= WEAK_TEXT_CHARS) {
        html = extracted.html;
        text = extracted.text ?? htmlToText(extracted.html);
        status = "full";
      } else if (rssHtml) {
        html = rssHtml;
        text = rssText;
        status = "rss_only";
      } else {
        html = "";
        text = "";
        status = "inaccessible";
        inaccessible = true;
      }
    }
  } else {
    html = rssHtml;
    text = rssText;
    status = rssText ? "rss_only" : "inaccessible";
    inaccessible = !rssText;
  }

  const article: Article = {
    id: hashId(canonicalUrl),
    title: item.title,
    source: feed.name,
    category: feed.category,
    url: item.url,
    canonicalUrl,
    normalizedUrl,
    publishedAt,
    author,
    html,
    text,
    rssSummary: rssHtml || rssText || null,
    images,
    extractionStatus: status,
    paywalled,
    inaccessible: inaccessible || paywalled,
    firstSeenAt: cached?.firstSeenAt ?? now,
    updatedAt: now,
  };

  const dup = deduper.has(article);
  if (dup && dup.id !== article.id) {
    ctx.stats.duplicates += 1;
    return null;
  }
  deduper.add(article);
  log.debug("article.ok", {
    title: article.title,
    source: article.source,
    status: article.extractionStatus,
  });
  return article;
}

function shouldRefresh(article: Article): boolean {
  if (article.extractionStatus === "full" && article.html && article.html.length > WEAK_TEXT_CHARS) {
    return false;
  }
  if (article.paywalled) return false;
  return true;
}

export function articleDayKey(article: Article, timeZone: string): string {
  return formatIsoDate(article.publishedAt ?? article.firstSeenAt, timeZone);
}

export function matchesTitleSource(
  title: string,
  source: string,
  dateIso: string | null,
  other: Article,
): boolean {
  return (
    titleSourceKey(title, source, dateIso) ===
    titleSourceKey(
      other.title,
      other.source,
      other.publishedAt ? formatIsoDate(other.publishedAt) : null,
    )
  );
}

export { normalizeTitle };
