import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  AppConfig,
  ExtractionStrategy,
  FeedConfig,
  WritingMode,
} from "./models.js";

const STRATEGIES: ExtractionStrategy[] = ["auto", "http", "playwright", "rss-only"];

export const DEFAULT_CONFIG_FILES = ["config.yaml", "config.yml"];

export function defaultConfig(): AppConfig {
  return {
    outputDir: "./output",
    database: "./data/cache.sqlite",
    userAgent: "rss2epub/1.0 (personal offline EPUB reader)",
    concurrency: 3,
    timeoutMs: 20_000,
    maxArticlesPerFeed: 30,
    rateLimitMs: 1500,
    timezone: "Asia/Tokyo",
    respectRobotsTxt: true,
    playwright: {
      enabled: true,
      headless: true,
    },
    epub: {
      titlePrefix: "日本ニュース",
      author: "rss2epub",
      splitByCategory: false,
      writingMode: "horizontal",
      embedImages: true,
      maxImageBytes: 2_500_000,
    },
    server: {
      host: "0.0.0.0",
      port: 8080,
    },
    tls: {},
    feeds: [],
  };
}

export function resolveConfigPath(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  for (const name of DEFAULT_CONFIG_FILES) {
    const candidate = path.resolve(name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Config file not found. Copy config.example.yaml to config.yaml, or pass --config <path>.`,
  );
}

export function loadConfig(configPath?: string): AppConfig {
  const resolved = resolveConfigPath(configPath);
  const raw = readFileSync(resolved, "utf8");
  const parsed = parseYaml(raw) ?? {};
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid config: ${resolved} must be a YAML mapping`);
  }
  return normalizeConfig(parsed as Record<string, unknown>, path.dirname(resolved));
}

export function normalizeConfig(
  raw: Record<string, unknown>,
  baseDir = process.cwd(),
): AppConfig {
  const defaults = defaultConfig();
  const playwrightRaw = asRecord(raw.playwright);
  const epubRaw = asRecord(raw.epub);
  const serverRaw = asRecord(raw.server);
  const tlsRaw = asRecord(raw.tls);

  const writingMode = String(
    epubRaw.writingMode ?? defaults.epub.writingMode,
  ) as WritingMode;
  if (writingMode !== "horizontal" && writingMode !== "vertical") {
    throw new Error(`epub.writingMode must be "horizontal" or "vertical"`);
  }

  const config: AppConfig = {
    outputDir: path.resolve(baseDir, String(raw.outputDir ?? defaults.outputDir)),
    database: path.resolve(baseDir, String(raw.database ?? defaults.database)),
    userAgent: String(raw.userAgent ?? defaults.userAgent),
    concurrency: asPositiveInt(raw.concurrency, defaults.concurrency),
    timeoutMs: asPositiveInt(raw.timeoutMs, defaults.timeoutMs),
    maxArticlesPerFeed: asPositiveInt(
      raw.maxArticlesPerFeed,
      defaults.maxArticlesPerFeed,
    ),
    rateLimitMs: asNonNegInt(raw.rateLimitMs, defaults.rateLimitMs),
    timezone: String(raw.timezone ?? defaults.timezone),
    respectRobotsTxt: asBool(raw.respectRobotsTxt, defaults.respectRobotsTxt),
    playwright: {
      enabled: asBool(playwrightRaw.enabled, defaults.playwright.enabled),
      headless: asBool(playwrightRaw.headless, defaults.playwright.headless),
      storageState: playwrightRaw.storageState
        ? path.resolve(baseDir, String(playwrightRaw.storageState))
        : undefined,
    },
    epub: {
      titlePrefix: String(epubRaw.titlePrefix ?? defaults.epub.titlePrefix),
      author: String(epubRaw.author ?? defaults.epub.author),
      splitByCategory: asBool(
        epubRaw.splitByCategory,
        defaults.epub.splitByCategory,
      ),
      writingMode,
      embedImages: asBool(epubRaw.embedImages, defaults.epub.embedImages),
      maxImageBytes: asPositiveInt(
        epubRaw.maxImageBytes,
        defaults.epub.maxImageBytes,
      ),
    },
    server: {
      host: String(serverRaw.host ?? defaults.server.host),
      port: asPositiveInt(serverRaw.port, defaults.server.port),
    },
    tls: {
      extraCaFile: tlsRaw.extraCaFile
        ? path.resolve(baseDir, String(tlsRaw.extraCaFile))
        : undefined,
    },
    feeds: parseFeeds(raw.feeds),
  };

  return config;
}

function parseFeeds(raw: unknown): FeedConfig[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("feeds must be a list");
  }
  return raw.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`feeds[${index}] must be a mapping`);
    }
    const row = item as Record<string, unknown>;
    const name = String(row.name ?? "").trim();
    const url = String(row.url ?? "").trim();
    if (!name) throw new Error(`feeds[${index}].name is required`);
    if (!url) throw new Error(`feeds[${index}].url is required`);
    try {
      new URL(url);
    } catch {
      throw new Error(`feeds[${index}].url is not a valid URL: ${url}`);
    }
    const extraction = row.extraction
      ? (String(row.extraction) as ExtractionStrategy)
      : undefined;
    if (extraction && !STRATEGIES.includes(extraction)) {
      throw new Error(
        `feeds[${index}].extraction must be one of ${STRATEGIES.join(", ")}`,
      );
    }
    return {
      name,
      url,
      category: String(row.category ?? "その他").trim() || "その他",
      enabled: asBool(row.enabled, true),
      maxArticles:
        row.maxArticles === undefined
          ? undefined
          : asPositiveInt(row.maxArticles, 30),
      extraction,
      extractor: row.extractor ? String(row.extractor) : undefined,
      timeoutMs:
        row.timeoutMs === undefined
          ? undefined
          : asPositiveInt(row.timeoutMs, 20_000),
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.toLowerCase();
    if (v === "true" || v === "yes" || v === "1") return true;
    if (v === "false" || v === "no" || v === "0") return false;
  }
  return Boolean(value);
}

function asPositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function asNonNegInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function enabledFeeds(
  config: AppConfig,
  filter?: { feed?: string; category?: string },
): FeedConfig[] {
  return config.feeds.filter((feed) => {
    if (!feed.enabled) return false;
    if (filter?.feed && feed.name !== filter.feed) return false;
    if (filter?.category && feed.category !== filter.category) return false;
    return true;
  });
}
