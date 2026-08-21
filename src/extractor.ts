import type { Browser, BrowserContext, Page } from "playwright";
import type { ArticleResult, ExtractionStrategy } from "./models.js";
import { emptyArticleResult } from "./models.js";
import { findExtractor, genericExtractor } from "./extractors/index.js";
import type { HttpClient } from "./http.js";
import { HttpError } from "./http.js";
import {
  detectAccessDenied,
  detectJsRequired,
  detectPaywall,
  finalizeResult,
  htmlToText,
  isWeakText,
} from "./html.js";
import { log } from "./log.js";

export interface ExtractorOptions {
  http: HttpClient;
  timeoutMs: number;
  strategy: ExtractionStrategy;
  extractorName?: string;
  playwright?: PlaywrightSession | null;
}

export class PlaywrightSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  constructor(
    private readonly opts: {
      enabled: boolean;
      headless: boolean;
      storageState?: string;
      userAgent: string;
    },
  ) {}

  get enabled(): boolean {
    return this.opts.enabled;
  }

  async page(): Promise<Page> {
    const context = await this.ensureContext();
    return context.newPage();
  }

  async close(): Promise<void> {
    try {
      if (this.context) {
        await Promise.all(this.context.pages().map((p) => p.close().catch(() => undefined)));
        await this.context.close();
      }
    } catch {
      // ignore
    }
    await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.browser = null;
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    log.info("playwright.launch", { headless: this.opts.headless });
    const { chromium } = await import("playwright");
    this.browser = await chromium.launch({
      headless: this.opts.headless,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    this.context = await this.browser.newContext({
      userAgent: this.opts.userAgent,
      locale: "ja-JP",
      storageState: this.opts.storageState,
    });
    log.info("playwright.ready");
    return this.context;
  }
}

export async function extractArticle(
  url: string,
  opts: ExtractorOptions,
): Promise<ArticleResult> {
  const strategy = opts.strategy;
  if (strategy === "rss-only") {
    return emptyArticleResult({ inaccessible: false });
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return emptyArticleResult({ inaccessible: true });
  }

  const site = findExtractor(parsed, opts.extractorName);

  if (strategy !== "playwright") {
    const httpResult = await extractViaHttp(url, site, opts);
    if (httpResult.kind === "done") return httpResult.result;
    if (strategy === "http") {
      return httpResult.result ?? emptyArticleResult({ inaccessible: true });
    }
    if (httpResult.kind === "paywalled" || httpResult.kind === "denied") {
      return httpResult.result;
    }
    if (opts.playwright?.enabled) {
      log.info("extract.playwright_fallback", { url, reason: httpResult.kind });
      return extractViaPlaywright(url, site, opts);
    }
    return httpResult.result ?? emptyArticleResult({ inaccessible: true });
  }

  if (!opts.playwright?.enabled) {
    return emptyArticleResult({ inaccessible: true });
  }
  return extractViaPlaywright(url, site, opts);
}

type HttpAttempt =
  | { kind: "done"; result: ArticleResult }
  | { kind: "paywalled"; result: ArticleResult }
  | { kind: "denied"; result: ArticleResult }
  | { kind: "js"; result: ArticleResult | null }
  | { kind: "weak"; result: ArticleResult | null }
  | { kind: "error"; result: ArticleResult | null };

async function extractViaHttp(
  url: string,
  site: ReturnType<typeof findExtractor>,
  opts: ExtractorOptions,
): Promise<HttpAttempt> {
  try {
    const policy = await opts.http.isAllowed(url);
    if (!policy.allowed) {
      return {
        kind: "denied",
        result: emptyArticleResult({ inaccessible: true }),
      };
    }
    const res = await opts.http.fetchText(url, { timeoutMs: opts.timeoutMs });
    if (detectAccessDenied(res.body, res.status)) {
      return {
        kind: "denied",
        result: emptyArticleResult({ inaccessible: true }),
      };
    }
    if (detectPaywall(res.body)) {
      return {
        kind: "paywalled",
        result: emptyArticleResult({
          paywalled: true,
          inaccessible: true,
          canonicalUrl: res.url,
        }),
      };
    }
    const pageUrl = new URL(res.url || url);
    let result =
      (await site.extractFromHtml(res.body, pageUrl)) ??
      (site.name !== "generic" ? await genericExtractor.extractFromHtml(res.body, pageUrl) : null);
    if (result?.paywalled) {
      return { kind: "paywalled", result: finalizeResult(result, pageUrl.href) };
    }
    if (!result || isWeakText(result.text ?? result.html)) {
      if (detectJsRequired(res.body, htmlToText(result?.html ?? "").length)) {
        return { kind: "js", result: result ? finalizeResult(result, pageUrl.href) : null };
      }
      return { kind: "weak", result: result ? finalizeResult(result, pageUrl.href) : null };
    }
    return { kind: "done", result: finalizeResult(result, pageUrl.href) };
  } catch (err) {
    if (err instanceof HttpError && err.status === 451) {
      return { kind: "denied", result: emptyArticleResult({ inaccessible: true }) };
    }
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      return { kind: "denied", result: emptyArticleResult({ inaccessible: true }) };
    }
    log.debug("extract.http_error", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: "error", result: null };
  }
}

async function extractViaPlaywright(
  url: string,
  site: ReturnType<typeof findExtractor>,
  opts: ExtractorOptions,
): Promise<ArticleResult> {
  if (!opts.playwright) {
    return emptyArticleResult({ inaccessible: true });
  }
  const policy = await opts.http.isAllowed(url);
  if (!policy.allowed) {
    return emptyArticleResult({ inaccessible: true });
  }
  let page: Page | undefined;
  try {
    page = await opts.playwright.page();
    page.setDefaultTimeout(opts.timeoutMs);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs });
    const html = await page.content();
    if (detectAccessDenied(html) || looksLikeCaptcha(html, await page.title())) {
      return emptyArticleResult({ inaccessible: true });
    }
    if (detectPaywall(html)) {
      return emptyArticleResult({ paywalled: true, inaccessible: true, canonicalUrl: page.url() });
    }
    const result = await site.extract(page);
    if (result.paywalled) return finalizeResult(result, page.url());
    if (!result.html && site.name !== "generic") {
      const fallback = await genericExtractor.extract(page);
      return finalizeResult(fallback, page.url());
    }
    return finalizeResult(result, page.url());
  } catch (err) {
    log.warn("extract.playwright_error", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyArticleResult({ inaccessible: true });
  } finally {
    await page?.close().catch(() => undefined);
  }
}

function looksLikeCaptcha(html: string, title: string): boolean {
  if (/just a moment|attention required|cloudflare/i.test(title)) return true;
  if (/hcaptcha|recaptcha|cf-challenge|challenges.cloudflare.com/i.test(html)) return true;
  return false;
}
