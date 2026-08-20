import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Article, ArticleImage, ExtractionStatus } from "./models.js";
import { jstDayRange } from "./util.js";

interface ArticleRow {
  id: string;
  url: string;
  canonical_url: string;
  normalized_url: string;
  title: string;
  source: string;
  category: string | null;
  author: string | null;
  published_at: string | null;
  first_seen_at: string;
  updated_at: string;
  extraction_status: string;
  paywalled: number;
  inaccessible: number;
  html: string | null;
  text: string | null;
  rss_summary: string | null;
  images_json: string | null;
}

export class ArticleCache {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS articles (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        normalized_url TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        category TEXT,
        author TEXT,
        published_at TEXT,
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        extraction_status TEXT NOT NULL,
        paywalled INTEGER NOT NULL DEFAULT 0,
        inaccessible INTEGER NOT NULL DEFAULT 0,
        html TEXT,
        text TEXT,
        rss_summary TEXT,
        images_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_articles_canonical ON articles(canonical_url);
      CREATE INDEX IF NOT EXISTS idx_articles_normalized ON articles(normalized_url);
      CREATE INDEX IF NOT EXISTS idx_articles_title_source ON articles(title, source);
      CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at);
      CREATE INDEX IF NOT EXISTS idx_articles_first_seen ON articles(first_seen_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  getByUrlKeys(canonicalUrl: string, normalizedUrl: string): Article | null {
    const row = this.db
      .prepare(
        `SELECT * FROM articles
         WHERE canonical_url = ? OR normalized_url = ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(canonicalUrl, normalizedUrl) as ArticleRow | undefined;
    return row ? rowToArticle(row) : null;
  }

  getByTitleSourceDate(title: string, source: string, day: string): Article | null {
    const rows = this.db
      .prepare(`SELECT * FROM articles WHERE title = ? AND source = ?`)
      .all(title, source) as ArticleRow[];
    for (const row of rows) {
      const article = rowToArticle(row);
      const iso = (article.publishedAt ?? article.firstSeenAt).toISOString().slice(0, 10);
      if (iso === day || (article.publishedAt && formatUtcDate(article.publishedAt) === day)) {
        return article;
      }
    }
    return rows[0] ? rowToArticle(rows[0]) : null;
  }

  upsert(article: Article): void {
    const existing = this.db
      .prepare(`SELECT first_seen_at FROM articles WHERE id = ?`)
      .get(article.id) as { first_seen_at: string } | undefined;
    const firstSeen = existing?.first_seen_at ?? article.firstSeenAt.toISOString();
    this.db
      .prepare(
        `INSERT INTO articles (
          id, url, canonical_url, normalized_url, title, source, category, author,
          published_at, first_seen_at, updated_at, extraction_status, paywalled,
          inaccessible, html, text, rss_summary, images_json
        ) VALUES (
          @id, @url, @canonical_url, @normalized_url, @title, @source, @category, @author,
          @published_at, @first_seen_at, @updated_at, @extraction_status, @paywalled,
          @inaccessible, @html, @text, @rss_summary, @images_json
        )
        ON CONFLICT(id) DO UPDATE SET
          url = excluded.url,
          canonical_url = excluded.canonical_url,
          normalized_url = excluded.normalized_url,
          title = excluded.title,
          source = excluded.source,
          category = excluded.category,
          author = excluded.author,
          published_at = excluded.published_at,
          updated_at = excluded.updated_at,
          extraction_status = excluded.extraction_status,
          paywalled = excluded.paywalled,
          inaccessible = excluded.inaccessible,
          html = excluded.html,
          text = excluded.text,
          rss_summary = excluded.rss_summary,
          images_json = excluded.images_json`,
      )
      .run({
        id: article.id,
        url: article.url,
        canonical_url: article.canonicalUrl,
        normalized_url: article.normalizedUrl,
        title: article.title,
        source: article.source,
        category: article.category,
        author: article.author,
        published_at: article.publishedAt?.toISOString() ?? null,
        first_seen_at: firstSeen,
        updated_at: article.updatedAt.toISOString(),
        extraction_status: article.extractionStatus,
        paywalled: article.paywalled ? 1 : 0,
        inaccessible: article.inaccessible ? 1 : 0,
        html: article.html,
        text: article.text,
        rss_summary: article.rssSummary,
        images_json: JSON.stringify(article.images ?? []),
      });
  }

  listForDate(dateStr: string, timeZone = "Asia/Tokyo"): Article[] {
    const { start, end } = jstDayRange(dateStr, timeZone);
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM articles
         WHERE (published_at IS NOT NULL AND published_at >= ? AND published_at <= ?)
            OR (published_at IS NULL AND first_seen_at >= ? AND first_seen_at <= ?)
         ORDER BY source ASC, published_at ASC, title ASC`,
      )
      .all(startIso, endIso, startIso, endIso) as ArticleRow[];
    return rows.map(rowToArticle);
  }

  cleanOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const info = this.db
      .prepare(`DELETE FROM articles WHERE first_seen_at < ? AND updated_at < ?`)
      .run(cutoff, cutoff);
    return info.changes;
  }

  clearAll(): number {
    const info = this.db.prepare(`DELETE FROM articles`).run();
    return info.changes;
  }

  static removeFiles(dbPath: string): string[] {
    if (dbPath === ":memory:") return [];
    const removed: string[] = [];
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      if (!existsSync(file)) continue;
      unlinkSync(file);
      removed.push(file);
    }
    return removed;
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM articles`).get() as { n: number };
    return row.n;
  }
}

function rowToArticle(row: ArticleRow): Article {
  let images: ArticleImage[] = [];
  if (row.images_json) {
    try {
      images = JSON.parse(row.images_json) as ArticleImage[];
    } catch {
      images = [];
    }
  }
  return {
    id: row.id,
    url: row.url,
    canonicalUrl: row.canonical_url,
    normalizedUrl: row.normalized_url,
    title: row.title,
    source: row.source,
    category: row.category ?? "その他",
    author: row.author,
    publishedAt: row.published_at ? new Date(row.published_at) : null,
    firstSeenAt: new Date(row.first_seen_at),
    updatedAt: new Date(row.updated_at),
    extractionStatus: row.extraction_status as ExtractionStatus,
    paywalled: Boolean(row.paywalled),
    inaccessible: Boolean(row.inaccessible),
    html: row.html ?? "",
    text: row.text ?? "",
    rssSummary: row.rss_summary,
    images,
  };
}

function formatUtcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
