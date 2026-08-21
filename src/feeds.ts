import Parser from "rss-parser";
import type { FeedConfig, FeedItem } from "./models.js";
import type { HttpClient } from "./http.js";
import { htmlToText, rssSummaryToHtml } from "./html.js";
import { log } from "./log.js";
import { parseDate } from "./util.js";

const parser = new Parser({
  timeout: 20000,
  headers: {},
  customFields: {
    item: [
      ["content:encoded", "contentEncoded"],
      ["dc:creator", "dcCreator"],
      ["dc:date", "dcDate"],
    ],
  },
});

export async function fetchFeedItems(
  feed: FeedConfig,
  http: HttpClient,
  timeoutMs: number,
): Promise<FeedItem[]> {
  const { body, url } = await http.fetchText(feed.url, { timeoutMs });
  return parseFeedXml(body, feed, url);
}

/**
 * Japanese RSS titles often contain a raw `&` ("A&B", "衣装&写真展").
 * XML then treats `&…` as an entity name and blows up on the next
 * ideographic space (U+3000) — sax: "Invalid character in entity name".
 * Escape ampersands that are not well-formed XML/HTML entity references.
 */
export function sanitizeFeedXml(xml: string): string {
  return xml.replace(/&(?!(?:[A-Za-z_][\w.-]*|#(?:\d+|x[0-9A-Fa-f]+));)/g, "&amp;");
}

export async function parseFeedXml(
  xml: string,
  feed: FeedConfig,
  sourceUrl = feed.url,
): Promise<FeedItem[]> {
  const parsed = await parser.parseString(sanitizeFeedXml(xml));
  const items: FeedItem[] = [];
  for (const raw of parsed.items ?? []) {
    const item = raw as typeof raw & {
      dcDate?: string;
      contentEncoded?: string;
      dcCreator?: string;
    };
    const url = pickUrl(item, sourceUrl);
    if (!url) {
      log.warn("feed.item_missing_url", { feed: feed.name, title: item.title });
      continue;
    }
    const html = pickSummaryHtml(item);
    const title = (item.title ?? "").trim() || "(無題)";
    items.push({
      feedName: feed.name,
      category: feed.category,
      title,
      url,
      publishedAt: parseDate(item.isoDate ?? item.pubDate ?? item.dcDate),
      author: pickAuthor(item),
      summaryHtml: html,
      summaryText: html ? htmlToText(html) : null,
      guid: typeof item.guid === "string" ? item.guid : undefined,
    });
  }
  return items;
}

function pickUrl(
  item: {
    link?: string;
    guid?: string;
    enclosure?: { url?: string };
  },
  feedUrl: string,
): string | null {
  const candidates = [item.link, typeof item.guid === "string" && looksLikeUrl(item.guid) ? item.guid : null];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return new URL(c, feedUrl).href;
    } catch {
      continue;
    }
  }
  return null;
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function pickAuthor(item: {
  creator?: string;
  author?: string;
  dcCreator?: string;
}): string | null {
  const raw = item.creator ?? item.dcCreator ?? item.author;
  if (!raw) return null;
  const trimmed = String(raw).trim();
  return trimmed || null;
}

function pickSummaryHtml(item: {
  contentEncoded?: string;
  "content:encoded"?: string;
  content?: string;
  summary?: string;
  contentSnippet?: string;
}): string | null {
  const raw =
    item.contentEncoded ??
    item["content:encoded"] ??
    item.content ??
    item.summary ??
    null;
  if (raw && String(raw).trim()) return rssSummaryToHtml(String(raw));
  if (item.contentSnippet) return rssSummaryToHtml(item.contentSnippet);
  return null;
}

export function limitFeedItems(items: FeedItem[], max: number): FeedItem[] {
  if (items.length <= max) return items;
  return items.slice(0, max);
}
