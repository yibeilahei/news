export type ExtractionStatus =
  | "full"
  | "rss_only"
  | "inaccessible"
  | "paywalled"
  | "failed"
  | "duplicate"
  | "skipped_robots"
  | "cached";

export type ExtractionStrategy = "auto" | "http" | "playwright" | "rss-only";

export type WritingMode = "horizontal" | "vertical";

export interface ArticleImage {
  originalUrl: string;
  localName?: string;
  mimeType?: string;
  alt?: string;
  caption?: string;
}

export interface ArticleResult {
  title?: string;
  html: string;
  text?: string;
  author?: string | null;
  publishedAt?: Date | null;
  canonicalUrl?: string;
  images?: ArticleImage[];
  paywalled: boolean;
  inaccessible: boolean;
}

export interface Article {
  id: string;
  title: string;
  source: string;
  category: string;
  url: string;
  canonicalUrl: string;
  normalizedUrl: string;
  publishedAt: Date | null;
  author: string | null;
  html: string;
  text: string;
  rssSummary: string | null;
  images: ArticleImage[];
  extractionStatus: ExtractionStatus;
  paywalled: boolean;
  inaccessible: boolean;
  firstSeenAt: Date;
  updatedAt: Date;
}

export interface FeedConfig {
  name: string;
  url: string;
  category: string;
  enabled: boolean;
  maxArticles?: number;
  extraction?: ExtractionStrategy;
  extractor?: string;
  timeoutMs?: number;
}

export interface PlaywrightConfig {
  enabled: boolean;
  headless: boolean;
  storageState?: string;
}

export interface EpubConfig {
  titlePrefix: string;
  author: string;
  splitByCategory: boolean;
  writingMode: WritingMode;
  embedImages: boolean;
  maxImageBytes: number;
}

export interface ServerConfig {
  host: string;
  port: number;
}

export interface TlsConfig {
  extraCaFile?: string;
}

export interface AppConfig {
  outputDir: string;
  database: string;
  userAgent: string;
  concurrency: number;
  feedConcurrency: number;
  timeoutMs: number;
  maxArticlesPerFeed: number;
  rateLimitMs: number;
  timezone: string;
  respectRobotsTxt: boolean;
  playwright: PlaywrightConfig;
  epub: EpubConfig;
  server: ServerConfig;
  tls: TlsConfig;
  feeds: FeedConfig[];
}

export interface FeedItem {
  feedName: string;
  category: string;
  title: string;
  url: string;
  publishedAt: Date | null;
  author: string | null;
  summaryHtml: string | null;
  summaryText: string | null;
  guid?: string;
}

export interface RunStats {
  feedsSuccessful: number;
  feedsFailed: number;
  discovered: number;
  full: number;
  rssOnly: number;
  inaccessible: number;
  paywalled: number;
  duplicates: number;
  failed: number;
  skippedRobots: number;
  cached: number;
  feedErrors: { name: string; error: string }[];
}

export function emptyStats(): RunStats {
  return {
    feedsSuccessful: 0,
    feedsFailed: 0,
    discovered: 0,
    full: 0,
    rssOnly: 0,
    inaccessible: 0,
    paywalled: 0,
    duplicates: 0,
    failed: 0,
    skippedRobots: 0,
    cached: 0,
    feedErrors: [],
  };
}

export function emptyArticleResult(
  partial: Partial<ArticleResult> = {},
): ArticleResult {
  return {
    html: "",
    paywalled: false,
    inaccessible: false,
    ...partial,
  };
}
