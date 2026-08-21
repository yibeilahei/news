import iconv from "iconv-lite";
import robotsParserMod from "robots-parser";
import { log } from "./log.js";
import { sleep } from "./util.js";

type RobotsFn = (
  url: string,
  body: string,
) => {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
};

const robotsParser: RobotsFn = (() => {
  const mod = robotsParserMod as unknown as RobotsFn | { default: RobotsFn };
  return typeof mod === "function" ? mod : mod.default;
})();

const MAX_BODY_BYTES = 6_000_000;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface RobotsInfo {
  allowed: (url: string, ua: string) => boolean;
  crawlDelayMs: number | null;
}

export class HttpClient {
  private readonly nextSlot = new Map<string, number>();
  private readonly hostGate = new Map<string, Promise<void>>();
  private readonly robots = new Map<string, RobotsInfo | "failed">();

  constructor(
    private readonly opts: {
      userAgent: string;
      timeoutMs: number;
      rateLimitMs: number;
      respectRobotsTxt: boolean;
    },
  ) {}

  async isAllowed(url: string): Promise<{ allowed: boolean; crawlDelayMs: number }> {
    if (!this.opts.respectRobotsTxt) {
      return { allowed: true, crawlDelayMs: this.opts.rateLimitMs };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, crawlDelayMs: this.opts.rateLimitMs };
    }
    const origin = parsed.origin;
    let info = this.robots.get(origin);
    if (!info) {
      info = await this.loadRobots(origin);
      this.robots.set(origin, info);
    }
    if (info === "failed") {
      return { allowed: true, crawlDelayMs: this.opts.rateLimitMs };
    }
    const allowed = info.allowed(url, this.opts.userAgent);
    const delay = Math.max(this.opts.rateLimitMs, info.crawlDelayMs ?? 0);
    return { allowed, crawlDelayMs: delay };
  }

  async fetchText(url: string, extra?: { timeoutMs?: number }): Promise<{
    url: string;
    status: number;
    headers: Headers;
    body: string;
  }> {
    const res = await this.fetchBuffer(url, extra);
    const body = decodeBody(res.body, res.headers.get("content-type"));
    return { url: res.url, status: res.status, headers: res.headers, body };
  }

  async fetchBuffer(
    url: string,
    extra?: { timeoutMs?: number },
  ): Promise<{ url: string; status: number; headers: Headers; body: Buffer }> {
    const timeoutMs = extra?.timeoutMs ?? this.opts.timeoutMs;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError(`Invalid URL: ${url}`);
    }

    const policy = await this.isAllowed(url);
    if (!policy.allowed) {
      throw new HttpError(`Blocked by robots.txt: ${url}`, 451, url);
    }
    await this.rateLimit(parsed.hostname, policy.crawlDelayMs);

    const attempts = 3;
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const result = await this.once(url, timeoutMs);
        if (result.status === 429 || result.status >= 500) {
          const retryAfter = parseRetryAfter(result.headers.get("retry-after"));
          const delay = retryAfter ?? 500 * 2 ** i + Math.floor(Math.random() * 200);
          log.warn("http.retry", { url, status: result.status, attempt: i + 1, delay });
          await sleep(delay);
          lastError = new HttpError(`HTTP ${result.status}`, result.status, url);
          continue;
        }
        if (result.status >= 400) {
          throw new HttpError(`HTTP ${result.status} for ${url}`, result.status, url);
        }
        return result;
      } catch (err) {
        lastError = err;
        if (err instanceof HttpError && err.status && err.status < 500 && err.status !== 429) {
          throw err;
        }
        const delay = 500 * 2 ** i + Math.floor(Math.random() * 200);
        log.warn("http.retry", {
          url,
          attempt: i + 1,
          delay,
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(delay);
      }
    }
    throw lastError instanceof Error ? lastError : new HttpError(String(lastError), undefined, url);
  }

  private async once(
    url: string,
    timeoutMs: number,
  ): Promise<{ url: string; status: number; headers: Headers; body: Buffer }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": this.opts.userAgent,
          Accept: "text/html,application/xhtml+xml,application/xml,application/rss+xml,application/atom+xml,text/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ja,en;q=0.8",
        },
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BODY_BYTES) {
        throw new HttpError(`Response too large (${buf.length} bytes)`, res.status, url);
      }
      return {
        url: res.url || url,
        status: res.status,
        headers: res.headers,
        body: buf,
      };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new HttpError(`Timeout after ${timeoutMs}ms: ${url}`, undefined, url);
      }
      throw new HttpError(`Request failed for ${url}: ${describeError(err)}`, undefined, url);
    } finally {
      clearTimeout(timer);
    }
  }

  private async rateLimit(hostname: string, minIntervalMs: number): Promise<void> {
    if (minIntervalMs <= 0) return;
    const prev = this.hostGate.get(hostname) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.hostGate.set(
      hostname,
      prev.then(
        () => mine,
        () => mine,
      ),
    );
    try {
      await prev;
      const now = Date.now();
      const next = this.nextSlot.get(hostname) ?? 0;
      if (now < next) await sleep(next - now);
      this.nextSlot.set(hostname, Date.now() + minIntervalMs);
    } finally {
      release();
    }
  }

  private async loadRobots(origin: string): Promise<RobotsInfo | "failed"> {
    const robotsUrl = `${origin}/robots.txt`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(this.opts.timeoutMs, 8000));
      const res = await fetch(robotsUrl, {
        signal: controller.signal,
        headers: { "User-Agent": this.opts.userAgent, Accept: "text/plain" },
      });
      clearTimeout(timer);
      if (!res.ok) return "failed";
      const body = await res.text();
      const parser = robotsParser(robotsUrl, body);
      const delaySec = parser.getCrawlDelay(this.opts.userAgent);
      return {
        allowed: (url, ua) => parser.isAllowed(url, ua) !== false,
        crawlDelayMs: delaySec ? Math.ceil(delaySec * 1000) : null,
      };
    } catch (err) {
      log.debug("robots.fetch_failed", {
        origin,
        error: err instanceof Error ? err.message : String(err),
      });
      return "failed";
    }
  }
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code ? `${cause.message} (${code})` : `${err.message}: ${cause.message}`;
  }
  return err.message;
}

export async function closeHttp(): Promise<void> {
  try {
    const { getGlobalDispatcher } = await import("undici");
    const dispatcher = getGlobalDispatcher();
    const close = dispatcher.close?.bind(dispatcher);
    const destroy = dispatcher.destroy?.bind(dispatcher);
    if (close) {
      await Promise.race([
        Promise.resolve(close()),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500);
          timer.unref();
        }),
      ]);
    }
    destroy?.();
  } catch {
    // native fetch dispatcher may already be torn down
  }
}

export async function applyTlsConfig(extraCaFile?: string): Promise<void> {
  const tls = await import("node:tls");
  const extra: string[] = [];
  if (extraCaFile) {
    const { readFileSync } = await import("node:fs");
    extra.push(readFileSync(extraCaFile, "utf8"));
  }

  const setDefault = (
    tls as typeof tls & {
      setDefaultCACertificates?: (certs: readonly string[]) => void;
      getCACertificates?: (type?: string) => string[];
    }
  ).setDefaultCACertificates;
  const getCerts = (
    tls as typeof tls & {
      getCACertificates?: (type?: string) => string[];
    }
  ).getCACertificates;

  if (typeof setDefault === "function" && typeof getCerts === "function") {
    const bundled = getCerts("default");
    let system: string[] = [];
    try {
      system = getCerts("system");
    } catch {
      system = [];
    }
    setDefault([...bundled, ...system, ...extra]);
    if (system.length > 0 || extra.length > 0) {
      log.info("tls.ca", { system: system.length, extra: extra.length });
    }
    return;
  }

  if (!extraCaFile) return;
  const { Agent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(
    new Agent({
      connect: {
        ca: [...tls.rootCertificates, ...extra],
      },
    }),
  );
  log.info("tls.extra_ca", { extraCaFile });
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const when = Date.parse(value);
  if (!Number.isNaN(when)) return Math.min(Math.max(when - Date.now(), 0), 30_000);
  return null;
}

export function decodeBody(buf: Buffer, contentType: string | null): string {
  let encoding = charsetFromContentType(contentType) ?? sniffCharset(buf) ?? "utf-8";
  encoding = normalizeEncoding(encoding);
  if (iconv.encodingExists(encoding)) {
    return iconv.decode(buf, encoding);
  }
  return buf.toString("utf8");
}

function charsetFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const m = contentType.match(/charset\s*=\s*("?)([^;";]+)\1/i);
  return m ? m[2].trim() : null;
}

function sniffCharset(buf: Buffer): string | null {
  const head = buf.subarray(0, 4096).toString("latin1");
  const m =
    head.match(/charset\s*=\s*["']?([a-zA-Z0-9_\-]+)/i) ??
    head.match(/encoding\s*=\s*["']([a-zA-Z0-9_\-]+)/i);
  return m ? m[1] : null;
}

function normalizeEncoding(enc: string): string {
  const e = enc.toLowerCase().replace(/_/g, "-");
  if (e === "shift-jis" || e === "shiftjis" || e === "sjis" || e === "windows-31j" || e === "cp932") {
    return "shiftjis";
  }
  if (e === "euc-jp" || e === "eucjp") return "eucjp";
  if (e === "iso-2022-jp") return "iso2022jp";
  if (e === "utf8") return "utf-8";
  return e;
}
