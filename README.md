# rss2epub

Japanese news RSS/Atom → EPUB 3 for KOReader (Sony DPT-RP1 and other Android e-ink devices).

The tool fetches the feeds you configure, tries to retrieve the full article when it is **legitimately accessible**, and builds a clean daily EPUB. Paywalled, login-gated, CAPTCHA-protected, or robots.txt-disallowed pages are never bypassed.

```
RSS/Atom feeds
    → parse, normalize, deduplicate
    → use substantial RSS content when available
    → otherwise HTTP extraction (@mozilla/readability + site extractors)
    → Playwright only when the page needs JavaScript
    → EPUB 3 for KOReader
```

## Requirements

- Node.js 22+
- Optional: [Playwright Chromium](https://playwright.dev/) for JavaScript-rendered pages

## Install

```sh
npm install
cp config.example.yaml config.yaml
npx playwright install chromium
npm run build
```

`npx playwright install chromium` is optional. Without it, the run still uses RSS + HTTP extraction.

## Configure

Edit `config.yaml`. Feeds are not hardcoded: enable, disable, or add any Japanese RSS/Atom URL.

```yaml
feeds:
  - name: NHK
    url: "https://www3.nhk.or.jp/rss/news/cat0.xml"
    category: "ニュース"
    enabled: true
    extractor: nhk

  - name: ITmedia NEWS
    url: "https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml"
    category: "IT"
    enabled: true
    extractor: itmedia
```

Per-feed options:

| Field | Meaning |
| --- | --- |
| `name` | Source label in the EPUB TOC |
| `url` | RSS or Atom URL |
| `category` | Grouping (`ニュース`, `IT`, …) |
| `enabled` | Skip when `false` |
| `maxArticles` | Cap for this feed |
| `extraction` | `auto` (default), `http`, `playwright`, `rss-only` |
| `extractor` | Site plugin (`nhk`, `sankei`, `mainichi`, `asahi`, `yomiuri`, `nikkei`, `itmedia`, `impress`, `generic`) |
| `timeoutMs` | Override request timeout |

Top-level options of note:

| Field | Meaning |
| --- | --- |
| `epub.titlePrefix` | EPUB title and filename stem (example config: `japan-news`) |
| `epub.splitByCategory` | Also write one EPUB per category |
| `epub.writingMode` | `horizontal` (default) or `vertical` |
| `respectRobotsTxt` | Honor `robots.txt` when `true` (code default). The example config sets `false`. |
| `timezone` | Date math for `--date` and cache lookups (default `Asia/Tokyo`) |

Publisher RSS URLs change. If a feed 404s, disable it and copy the current URL from the publisher’s own RSS listing.

## Commands

```sh
npx rss2epub update
npx rss2epub update --date 2026-08-20
npx rss2epub update --feed NHK
npx rss2epub update --category IT
npx rss2epub update --max-articles 100
npx rss2epub update --no-playwright
npx rss2epub update --from-cache --date 2026-08-20
npx rss2epub update --split-by-category

npx rss2epub list-feeds
npx rss2epub test-feed NHK
npx rss2epub test-feed NHK --limit 5

npx rss2epub clean-cache
npx rss2epub clean-cache --older-than 14
npx rss2epub clean-cache --all

npx rss2epub serve
npx rss2epub serve --port 8080 --host 0.0.0.0
```

Global flags: `-c, --config <path>` (default `config.yaml` / `config.yml` in the current directory) and `-v, --verbose`.

During development you can run `npm run dev -- update` (or `npx tsx src/cli.ts update`) instead of the compiled binary.

Dates use `timezone` from config (`Asia/Tokyo` by default). `--date` other than today generates from the SQLite cache (historical RSS is not rewound). `clean-cache` without `--all` deletes entries older than 30 days.

### Output

Filenames are `{date}-{epub.titlePrefix}.epub`. With the example config (`titlePrefix: japan-news`):

```
output/
    2026-08-20-japan-news.epub
```

With `epub.splitByCategory: true` or `--split-by-category`, the combined file is still written, plus one EPUB per category:

```
2026-08-20-japan-news.epub
2026-08-20-IT.epub
2026-08-20-テクノロジー.epub
```

If `titlePrefix` is omitted, the code default is `日本ニュース`.

### Local HTTP server

`rss2epub serve` lists EPUBs so the tablet can download them on the LAN. Open the printed `http://<lan-ip>:8080/` URL in the device browser.

## Extraction rules

For each article:

1. If the RSS/Atom body is substantial, use it.
2. Otherwise fetch the page over HTTP and run the matching site extractor, falling back to Readability.
3. If the HTTP result is empty or clearly JS-rendered, open the URL in Playwright.
4. If the page is paywalled, blocked, or otherwise inaccessible: keep the RSS title and summary, mark it accordingly, include the original URL, and continue.

Marks used in the EPUB:

- Paywalled: 「有料記事・本文取得不可」
- Blocked by robots.txt: 「robots.txt により本文取得を省略しました」
- Other inaccessible / failed fetches: 「本文取得不可」

Legitimate browser logins are allowed via `playwright.storageState` (a Playwright storageState JSON you create yourself after a normal login). That path is not a paywall bypass.

## EPUB / KOReader

- EPUB 3, `dc:language = ja`, UTF-8
- Semantic HTML: headings, paragraphs, lists, blockquotes, tables, ruby/furigana
- No JavaScript, no external resources at reading time
- Images embedded when downloadable
- Nested TOC by source
- CSS for horizontal Japanese (default) or `epub.writingMode: vertical`

Each article page:

```
Title
Source · publication date
Author (if known)
Body
原文: URL
```

Paywalled / inaccessible:

```
Title
Source · publication date
「有料記事・本文取得不可」  (or the inaccessible / robots notice)
RSSで取得できた概要:
…
原文: URL
```

## Cache

SQLite at `data/cache.sqlite` stores URL, canonical URL, title, source, category, dates, extraction/paywall status, and article HTML so the same URL is not re-downloaded without need.

Dedup keys, in order: canonical URL → normalized URL → normalized title + source + JST date.

## Logging

A typical run ends with:

```
Feeds:
  12 successful
  2 failed

Articles:
  87 discovered
  61 full articles
  18 RSS summaries only
  8 inaccessible/duplicates

Detail:
  paywalled=3 inaccessible=2 duplicates=3
  cached=0 failed=1 robots=2
```

`--verbose` prints per-article debug lines.

## TLS / corporate proxies

On Node.js 22.15+/24, rss2epub merges the OS certificate store so corporate TLS inspection usually works without extra setup.

If requests still fail with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`:

```sh
export NODE_OPTIONS="--use-system-ca"
npx rss2epub update
```

or set `NODE_EXTRA_CA_CERTS` to a PEM file, or in `config.yaml`:

```yaml
tls:
  extraCaFile: ./corp-root.pem
```

TLS verification is never disabled.

## Project layout

```
.
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── config.example.yaml
├── src/
│   ├── index.ts
│   ├── cli.ts
│   ├── config.ts
│   ├── feeds.ts
│   ├── articles.ts
│   ├── extractor.ts
│   ├── html.ts
│   ├── http.ts
│   ├── dedup.ts
│   ├── cache.ts
│   ├── epub.ts
│   ├── server.ts
│   ├── log.ts
│   ├── models.ts
│   ├── util.ts
│   └── extractors/
│       ├── index.ts
│       ├── types.ts
│       ├── common.ts
│       ├── generic.ts
│       ├── nhk.ts
│       ├── sankei.ts
│       ├── mainichi.ts
│       ├── asahi.ts
│       ├── yomiuri.ts
│       ├── nikkei.ts
│       ├── itmedia.ts
│       └── impress.ts
└── tests/
    ├── feeds.test.ts
    ├── extraction.test.ts
    ├── dedup.test.ts
    ├── epub.test.ts
    └── fixtures/
        └── sample-feed.xml
```

## Tests

```sh
npm test
```

Tests do not hit the network. They cover RSS parsing, URL/title dedup, paywall detection, sanitization, extractor routing, and EPUB 3 structure.

## Access policy

This is a personal offline reader.

- Honors `robots.txt` when `respectRobotsTxt: true`
- Uses timeouts, retries with backoff, per-domain rate limits, and bounded concurrency
- One failed feed or article never aborts the run
- Does **not** break paywalls, CAPTCHAs, authentication, or other access controls
```