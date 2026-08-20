#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { ArticleCache } from "./cache.js";
import { collectArticles } from "./articles.js";
import { writeEpubs } from "./epub.js";
import { applyTlsConfig, HttpClient } from "./http.js";
import { startServer } from "./server.js";
import { fetchFeedItems, limitFeedItems } from "./feeds.js";
import { extractArticle, PlaywrightSession } from "./extractor.js";
import { formatRunSummary, log, setLogLevel } from "./log.js";
import { isIsoDate, todayIso } from "./util.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("rss2epub")
    .description("Japanese news RSS → EPUB 3 for KOReader")
    .version(pkg.version)
    .option("-c, --config <path>", "path to config.yaml")
    .option("-v, --verbose", "debug logging")
    .hook("preAction", (thisCommand) => {
      const opts = thisCommand.optsWithGlobals() as { verbose?: boolean };
      if (opts.verbose) setLogLevel("debug");
    });

  program
    .command("update")
    .description("Fetch enabled feeds and generate today's EPUB")
    .option("--date <YYYY-MM-DD>", "JST date (default: today)")
    .option("--feed <name>", "only this feed name")
    .option("--category <name>", "only this category")
    .option("--max-articles <n>", "max articles per feed", parseInt)
    .option("--no-playwright", "disable Playwright even if enabled in config")
    .option("--from-cache", "generate from cache without fetching")
    .option("--split-by-category", "also write one EPUB per category")
    .action(async (opts, cmd) => {
      const global = cmd.optsWithGlobals() as { config?: string };
      const config = await readyConfig(global.config);
      if (opts.splitByCategory) config.epub.splitByCategory = true;
      const date = opts.date ?? todayIso(config.timezone);
      if (!isIsoDate(date)) {
        throw new Error(`Invalid date: ${date} (expected YYYY-MM-DD)`);
      }
      if (opts.feed && !config.feeds.some((f) => f.name === opts.feed)) {
        throw new Error(`Unknown feed: ${opts.feed}`);
      }
      const cache = new ArticleCache(config.database);
      const http = new HttpClient({
        userAgent: config.userAgent,
        timeoutMs: config.timeoutMs,
        rateLimitMs: config.rateLimitMs,
        respectRobotsTxt: config.respectRobotsTxt,
      });
      try {
        log.info("update.start", { date, feed: opts.feed, category: opts.category });
        const { articles, stats } = await collectArticles(config, cache, http, {
          date,
          feed: opts.feed,
          category: opts.category,
          maxArticles: opts.maxArticles,
          playwrightEnabled: opts.playwright === false ? false : undefined,
          fromCache: Boolean(opts.fromCache),
        });
        if (articles.length === 0) {
          log.warn("update.no_articles", { date });
        }
        log.info("update.epub", { articles: articles.length });
        const files = await writeEpubs(articles, config, date, http);
        console.log("");
        console.log(formatRunSummary(stats));
        console.log("");
        for (const file of files) {
          console.log(`Wrote ${file.path} (${file.articleCount} articles)`);
        }
        if (stats.feedErrors.length) {
          console.log("");
          console.log("Feed errors:");
          for (const err of stats.feedErrors) {
            console.log(`  ${err.name}: ${err.error}`);
          }
        }
      } finally {
        cache.close();
      }
    });

  program
    .command("list-feeds")
    .description("List configured feeds")
    .action((opts, cmd) => {
      const global = cmd.optsWithGlobals() as { config?: string };
      const config = loadConfig(global.config);
      const rows = config.feeds.map((f) => ({
        name: f.name,
        category: f.category,
        enabled: f.enabled ? "yes" : "no",
        extraction: f.extraction ?? "auto",
        extractor: f.extractor ?? "(auto)",
        url: f.url,
      }));
      if (rows.length === 0) {
        console.log("No feeds configured.");
        return;
      }
      const widths = {
        name: Math.max(4, ...rows.map((r) => r.name.length)),
        category: Math.max(8, ...rows.map((r) => r.category.length)),
        enabled: 7,
        extraction: 10,
        extractor: Math.max(9, ...rows.map((r) => r.extractor.length)),
      };
      const header = [
        pad("name", widths.name),
        pad("category", widths.category),
        pad("enabled", widths.enabled),
        pad("extract", widths.extraction),
        pad("extractor", widths.extractor),
        "url",
      ].join("  ");
      console.log(header);
      for (const r of rows) {
        console.log(
          [
            pad(r.name, widths.name),
            pad(r.category, widths.category),
            pad(r.enabled, widths.enabled),
            pad(r.extraction, widths.extraction),
            pad(r.extractor, widths.extractor),
            r.url,
          ].join("  "),
        );
      }
    });

  program
    .command("test-feed")
    .description("Fetch a feed and try extracting the first few articles")
    .argument("<name>", "feed name")
    .option("--limit <n>", "articles to test", (v) => parseInt(v, 10), 2)
    .action(async (name: string, opts, cmd) => {
      const global = cmd.optsWithGlobals() as { config?: string };
      const config = await readyConfig(global.config);
      const feed = config.feeds.find((f) => f.name === name);
      if (!feed) {
        throw new Error(`Unknown feed: ${name}`);
      }
      const http = new HttpClient({
        userAgent: config.userAgent,
        timeoutMs: feed.timeoutMs ?? config.timeoutMs,
        rateLimitMs: config.rateLimitMs,
        respectRobotsTxt: config.respectRobotsTxt,
      });
      console.log(`Feed: ${feed.name}`);
      console.log(`URL:  ${feed.url}`);
      const items = await fetchFeedItems(feed, http, feed.timeoutMs ?? config.timeoutMs);
      const limited = limitFeedItems(items, opts.limit);
      console.log(`Items: ${items.length} (testing ${limited.length})`);
      const playwright = config.playwright.enabled
        ? new PlaywrightSession({
            enabled: true,
            headless: config.playwright.headless,
            storageState: config.playwright.storageState,
            userAgent: config.userAgent,
          })
        : null;
      try {
        for (const item of limited) {
          console.log("");
          console.log(`- ${item.title}`);
          console.log(`  ${item.url}`);
          const result = await extractArticle(item.url, {
            http,
            timeoutMs: feed.timeoutMs ?? config.timeoutMs,
            strategy: feed.extraction ?? "auto",
            extractorName: feed.extractor,
            playwright,
          });
          const chars = (result.text ?? "").length;
          console.log(
            `  paywalled=${result.paywalled} inaccessible=${result.inaccessible} chars=${chars}`,
          );
          if (result.title) console.log(`  extracted title: ${result.title}`);
        }
      } finally {
        await playwright?.close();
      }
    });

  program
    .command("clean-cache")
    .description("Delete cached articles")
    .option("--older-than <days>", "delete entries older than N days", (v) => parseInt(v, 10), 30)
    .option("--all", "delete the entire cache")
    .action((opts, cmd) => {
      const global = cmd.optsWithGlobals() as { config?: string };
      const config = loadConfig(global.config);
      if (opts.all) {
        const removed = ArticleCache.removeFiles(config.database);
        if (removed.length === 0) {
          console.log(`No cache file at ${config.database}`);
          return;
        }
        for (const file of removed) {
          console.log(`Deleted ${file}`);
        }
        return;
      }
      const cache = new ArticleCache(config.database);
      try {
        const before = cache.count();
        const deleted = cache.cleanOlderThan(opts.olderThan);
        console.log(`Removed ${deleted} of ${before} cached articles.`);
      } finally {
        cache.close();
      }
    });

  program
    .command("serve")
    .description("Serve generated EPUBs over HTTP for the local network")
    .option("--port <n>", "port", (v) => parseInt(v, 10))
    .option("--host <host>", "bind address")
    .action((opts, cmd) => {
      const global = cmd.optsWithGlobals() as { config?: string };
      const config = loadConfig(global.config);
      startServer({
        root: config.outputDir,
        host: opts.host ?? config.server.host,
        port: opts.port ?? config.server.port,
      });
    });

  await program.parseAsync(process.argv);
}

async function readyConfig(configPath?: string) {
  const config = loadConfig(configPath);
  await applyTlsConfig(config.tls.extraCaFile);
  return config;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

main().catch((err) => {
  log.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
