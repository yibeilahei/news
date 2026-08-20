import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import type { AppConfig, Article } from "./models.js";
import type { HttpClient } from "./http.js";
import { parseDocument } from "./html.js";
import { log } from "./log.js";
import {
  extensionFromMime,
  formatJaDate,
  hashHex,
  mimeFromExtension,
  xmlEscape,
} from "./util.js";

export interface EpubBuildResult {
  path: string;
  title: string;
  articleCount: number;
  category?: string;
}

export async function writeEpubs(
  articles: Article[],
  config: AppConfig,
  date: string,
  http: HttpClient,
): Promise<EpubBuildResult[]> {
  mkdirSync(config.outputDir, { recursive: true });
  const results: EpubBuildResult[] = [];

  if (config.epub.splitByCategory) {
    const byCat = groupBy(articles, (a) => a.category || "その他");
    for (const [category, group] of byCat) {
      const title = `${date}-${category}`;
      const filename = `${date}-${sanitizeFilename(category)}.epub`;
      const out = path.join(config.outputDir, filename);
      await buildEpubFile(group, config, date, http, {
        title: `${config.epub.titlePrefix} ${category} ${date}`,
        filename: out,
        category,
      });
      results.push({ path: out, title, articleCount: group.length, category });
    }
  }

  const filename = `${date}-${sanitizeFilename(config.epub.titlePrefix)}.epub`;
  const out = path.join(config.outputDir, filename);
  await buildEpubFile(articles, config, date, http, {
    title: `${config.epub.titlePrefix} ${date}`,
    filename: out,
  });
  results.push({
    path: out,
    title: `${config.epub.titlePrefix} ${date}`,
    articleCount: articles.length,
  });
  return results;
}

async function buildEpubFile(
  articles: Article[],
  config: AppConfig,
  date: string,
  http: HttpClient,
  opts: { title: string; filename: string; category?: string },
): Promise<void> {
  const bookId = `urn:uuid:${randomUUID()}`;
  const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const writingMode = config.epub.writingMode;
  const grouped = groupArticles(articles, config);
  const totalArticles = grouped.reduce((n, g) => n + g.articles.length, 0);
  log.info("epub.start", {
    title: opts.title,
    articles: totalArticles,
    embedImages: config.epub.embedImages,
  });

  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", containerXml());

  const manifest: ManifestItem[] = [
    { id: "nav", href: "nav.xhtml", mediaType: "application/xhtml+xml", properties: "nav" },
    { id: "ncx", href: "toc.ncx", mediaType: "application/x-dtbncx+xml" },
    { id: "css", href: "styles/stylesheet.css", mediaType: "text/css" },
    { id: "cover", href: "text/cover.xhtml", mediaType: "application/xhtml+xml" },
  ];
  const spine: string[] = ["cover"];

  zip.file("OEBPS/styles/stylesheet.css", stylesheet(writingMode));
  zip.file(
    "OEBPS/text/cover.xhtml",
    coverXhtml(opts.title, date, grouped, config, articles.length),
  );

  let chapterIndex = 0;
  const chapterFiles: { id: string; href: string; title: string; source: string }[] = [];
  const imageManifest: ManifestItem[] = [];

  for (const group of grouped) {
    for (const article of group.articles) {
      chapterIndex += 1;
      const id = `ch${String(chapterIndex).padStart(4, "0")}`;
      const href = `text/${id}.xhtml`;
      let html = article.html;
      const images: EmbeddedImage[] = [];
      if (config.epub.embedImages) {
        log.info("epub.article", {
          done: chapterIndex,
          total: totalArticles,
          title: article.title.slice(0, 80),
        });
        const rewritten = await embedImages(html, article, http, config);
        html = rewritten.html;
        images.push(...rewritten.images);
      } else if (chapterIndex === 1 || chapterIndex % 20 === 0 || chapterIndex === totalArticles) {
        log.info("epub.article", {
          done: chapterIndex,
          total: totalArticles,
          title: article.title.slice(0, 80),
        });
      }
      for (const img of images) {
        const imgId = `${id}-${img.localName.replace(/\W/g, "")}`;
        zip.file(`OEBPS/images/${img.localName}`, img.data);
        imageManifest.push({
          id: imgId,
          href: `images/${img.localName}`,
          mediaType: img.mimeType,
        });
      }
      zip.file(
        `OEBPS/${href}`,
        articleXhtml(article, html, writingMode, config.timezone),
      );
      manifest.push({ id, href, mediaType: "application/xhtml+xml" });
      spine.push(id);
      chapterFiles.push({ id, href, title: article.title, source: article.source });
    }
  }

  zip.file("OEBPS/nav.xhtml", navXhtml(opts.title, grouped, chapterFiles, writingMode));
  zip.file("OEBPS/toc.ncx", tocNcx(opts.title, bookId, chapterFiles));
  zip.file(
    "OEBPS/package.opf",
    packageOpf({
      title: opts.title,
      author: config.epub.author,
      language: "ja",
      bookId,
      modified,
      date,
      manifest: [...manifest, ...imageManifest],
      spine,
    }),
  );

  log.info("epub.pack", { filename: opts.filename });
  const buf = await zip.generateAsync({
    type: "nodebuffer",
    mimeType: "application/epub+zip",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  mkdirSync(path.dirname(opts.filename), { recursive: true });
  writeFileSync(opts.filename, buf);
  log.info("epub.written", { path: opts.filename, articles: articles.length });
}

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties?: string;
}

interface SourceGroup {
  source: string;
  articles: Article[];
}

function groupArticles(articles: Article[], config: AppConfig): SourceGroup[] {
  const order = config.feeds.map((f) => f.name);
  const map = new Map<string, Article[]>();
  for (const article of articles) {
    if (article.extractionStatus === "duplicate") continue;
    const list = map.get(article.source) ?? [];
    list.push(article);
    map.set(article.source, list);
  }
  const groups: SourceGroup[] = [];
  for (const name of order) {
    const list = map.get(name);
    if (list && list.length) {
      groups.push({ source: name, articles: list });
      map.delete(name);
    }
  }
  for (const [source, list] of map) {
    groups.push({ source, articles: list });
  }
  if (groups.length === 0) {
    groups.push({ source: "その他", articles: [] });
  }
  return groups;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    if ((item as Article).extractionStatus === "duplicate") continue;
    const k = key(item);
    const list = map.get(k) ?? [];
    list.push(item);
    map.set(k, list);
  }
  return map;
}

function containerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
}

function packageOpf(opts: {
  title: string;
  author: string;
  language: string;
  bookId: string;
  modified: string;
  date: string;
  manifest: ManifestItem[];
  spine: string[];
}): string {
  const manifest = opts.manifest
    .map((item) => {
      const props = item.properties ? ` properties="${item.properties}"` : "";
      return `    <item id="${xmlEscape(item.id)}" href="${xmlEscape(item.href)}" media-type="${xmlEscape(item.mediaType)}"${props}/>`;
    })
    .join("\n");
  const spine = opts.spine
    .map((id) => `    <itemref idref="${xmlEscape(id)}"/>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0" xml:lang="ja">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">${xmlEscape(opts.bookId)}</dc:identifier>
    <dc:title>${xmlEscape(opts.title)}</dc:title>
    <dc:language>${xmlEscape(opts.language)}</dc:language>
    <dc:creator>${xmlEscape(opts.author)}</dc:creator>
    <dc:date>${xmlEscape(opts.date)}</dc:date>
    <dc:description>Japanese news digest generated by rss2epub for offline reading.</dc:description>
    <meta property="dcterms:modified">${xmlEscape(opts.modified)}</meta>
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine toc="ncx">
${spine}
  </spine>
</package>
`;
}

function stylesheet(writingMode: "horizontal" | "vertical"): string {
  return `@charset "UTF-8";
@namespace epub "http://www.idpf.org/2007/ops";

html {
  font-family: "Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif CJK JP", "Source Han Serif JP", "Hiragino Sans", serif;
}
body {
  line-height: 1.85;
  font-size: 1em;
  margin: 1em 1.2em;
  color: #111;
  widows: 2;
  orphans: 2;
}
body.vertical {
  writing-mode: vertical-rl;
  -epub-writing-mode: vertical-rl;
  -webkit-writing-mode: vertical-rl;
  line-height: 1.95;
  margin: 1.2em 1em;
}
h1 {
  font-size: 1.35em;
  font-weight: bold;
  line-height: 1.5;
  margin: 0 0 0.8em 0;
  page-break-after: avoid;
  break-after: avoid;
}
h2, h3, h4 {
  font-weight: bold;
  line-height: 1.5;
  margin: 1.2em 0 0.6em 0;
  page-break-after: avoid;
}
.meta, .author {
  font-size: 0.9em;
  color: #444;
  margin: 0 0 0.4em 0;
}
.paywall-notice {
  border: 1px solid #888;
  padding: 0.8em 1em;
  margin: 1em 0;
  font-weight: bold;
}
.rss-label {
  margin-top: 1em;
  font-weight: bold;
}
.rss-summary {
  margin-top: 0.4em;
}
.source-url {
  margin-top: 1.6em;
  font-size: 0.85em;
  word-break: break-all;
  overflow-wrap: anywhere;
}
p {
  margin: 0.7em 0;
  text-indent: 1em;
}
p.noindent, h1 + p, .meta, .author, .source-url, .paywall-notice, .rss-label {
  text-indent: 0;
}
blockquote {
  margin: 1em 1.5em;
  padding-left: 0.8em;
  border-left: 3px solid #ccc;
}
body.vertical blockquote {
  padding-left: 0;
  padding-top: 0.8em;
  border-left: none;
  border-top: 3px solid #ccc;
}
ul, ol {
  margin: 0.6em 1.5em;
}
li {
  margin: 0.2em 0;
}
figure {
  margin: 1em 0;
  text-align: center;
  page-break-inside: avoid;
}
figcaption {
  font-size: 0.85em;
  color: #444;
  margin-top: 0.4em;
  text-indent: 0;
}
img {
  max-width: 100%;
  height: auto;
}
body.vertical img {
  max-height: 90%;
  max-width: 100%;
}
ruby rt {
  font-size: 0.5em;
}
a {
  color: inherit;
  text-decoration: underline;
}
table {
  border-collapse: collapse;
  margin: 1em 0;
  font-size: 0.95em;
}
th, td {
  border: 1px solid #ccc;
  padding: 0.3em 0.5em;
}
.cover-title {
  font-size: 1.8em;
  font-weight: bold;
  text-indent: 0;
  margin: 2em 0 0.4em 0;
  text-align: center;
}
.cover-date {
  font-size: 1.1em;
  text-align: center;
  text-indent: 0;
}
.cover-meta {
  margin-top: 2em;
  text-indent: 0;
  text-align: center;
}
nav#toc ol {
  list-style-type: none;
  margin: 0.4em 0 0.4em 1em;
  padding: 0;
}
nav#toc li {
  margin: 0.25em 0;
}

/* Default writing mode: ${writingMode} */
`;
}

function xhtmlShell(
  title: string,
  bodyClass: string,
  body: string,
  cssHref = "../styles/stylesheet.css",
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja" lang="ja">
<head>
  <meta charset="UTF-8"/>
  <title>${xmlEscape(title)}</title>
  <link rel="stylesheet" type="text/css" href="${xmlEscape(cssHref)}"/>
</head>
<body class="${xmlEscape(bodyClass)}">
${body}
</body>
</html>
`;
}

function coverXhtml(
  title: string,
  date: string,
  groups: SourceGroup[],
  config: AppConfig,
  count: number,
): string {
  const display = formatJaDate(new Date(`${date}T12:00:00+09:00`), config.timezone);
  const sources = groups
    .filter((g) => g.articles.length > 0)
    .map((g) => `${xmlEscape(g.source)}（${g.articles.length}）`)
    .join(" · ");
  const body = `  <h1 class="cover-title">${xmlEscape(title)}</h1>
  <p class="cover-date noindent">${xmlEscape(display)}</p>
  <p class="cover-meta noindent">${count} 件の記事</p>
  <p class="cover-meta noindent">${sources || "記事なし"}</p>
  <p class="cover-meta noindent">個人のオフライン閲覧用。有料記事は本文を取得しません。</p>`;
  return xhtmlShell(title, config.epub.writingMode, body);
}

function articleXhtml(
  article: Article,
  bodyHtml: string,
  writingMode: "horizontal" | "vertical",
  timeZone: string,
): string {
  const dateLabel = article.publishedAt
    ? formatJaDate(article.publishedAt, timeZone)
    : "";
  const metaBits = [xmlEscape(article.source), dateLabel ? xmlEscape(dateLabel) : ""]
    .filter(Boolean)
    .join(" · ");
  const author = article.author
    ? `<p class="author noindent">${xmlEscape(article.author)}</p>`
    : "";
  let main: string;
  if (article.paywalled || article.extractionStatus === "paywalled") {
    const summary = article.rssSummary
      ? htmlToXhtmlFragment(article.rssSummary)
      : "<p>（概要なし）</p>";
    main = `<p class="paywall-notice noindent">有料記事・本文取得不可</p>
<p class="rss-label noindent">RSSで取得できた概要:</p>
<div class="rss-summary">
${summary}
</div>`;
  } else if (
    article.extractionStatus === "inaccessible" ||
    article.extractionStatus === "failed" ||
    article.extractionStatus === "skipped_robots" ||
    (!bodyHtml && article.rssSummary)
  ) {
    const summary = article.rssSummary
      ? htmlToXhtmlFragment(article.rssSummary)
      : bodyHtml
        ? htmlToXhtmlFragment(bodyHtml)
        : "<p>（本文を取得できませんでした）</p>";
    const notice =
      article.extractionStatus === "skipped_robots"
        ? "robots.txt により本文取得を省略しました"
        : "本文取得不可";
    main = `<p class="paywall-notice noindent">${notice}</p>
<p class="rss-label noindent">RSSで取得できた概要:</p>
<div class="rss-summary">
${summary}
</div>`;
  } else {
    main = htmlToXhtmlFragment(bodyHtml || article.rssSummary || "<p>（本文なし）</p>");
  }
  const url = article.canonicalUrl || article.url;
  const body = `  <article>
    <h1>${xmlEscape(article.title)}</h1>
    <p class="meta noindent">${metaBits}</p>
    ${author}
    ${main}
    <p class="source-url noindent">原文: ${xmlEscape(url)}</p>
  </article>`;
  return xhtmlShell(article.title, writingMode, body);
}

function navXhtml(
  title: string,
  groups: SourceGroup[],
  chapters: { id: string; href: string; title: string; source: string }[],
  writingMode: string,
): string {
  const bySource = new Map<string, typeof chapters>();
  for (const ch of chapters) {
    const list = bySource.get(ch.source) ?? [];
    list.push(ch);
    bySource.set(ch.source, list);
  }
  const parts: string[] = [];
  for (const group of groups) {
    const chs = bySource.get(group.source) ?? [];
    if (chs.length === 0) continue;
    const items = chs
      .map((ch) => `        <li><a href="${xmlEscape(ch.href)}">${xmlEscape(ch.title)}</a></li>`)
      .join("\n");
    parts.push(`      <li>
        <span>${xmlEscape(group.source)}</span>
        <ol>
${items}
        </ol>
      </li>`);
  }
  const body = `  <nav epub:type="toc" id="toc">
    <h1>目次</h1>
    <ol>
      <li><a href="text/cover.xhtml">表紙</a></li>
${parts.join("\n")}
    </ol>
  </nav>`;
  return xhtmlShell(`目次 — ${title}`, writingMode, body, "styles/stylesheet.css");
}

function tocNcx(
  title: string,
  bookId: string,
  chapters: { id: string; href: string; title: string; source: string }[],
): string {
  const points = [
    `    <navPoint id="navpoint-cover" playOrder="1">
      <navLabel><text>表紙</text></navLabel>
      <content src="text/cover.xhtml"/>
    </navPoint>`,
  ];
  let order = 2;
  for (const ch of chapters) {
    points.push(`    <navPoint id="navpoint-${xmlEscape(ch.id)}" playOrder="${order}">
      <navLabel><text>${xmlEscape(`${ch.source} — ${ch.title}`)}</text></navLabel>
      <content src="${xmlEscape(ch.href)}"/>
    </navPoint>`);
    order += 1;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${xmlEscape(bookId)}"/>
    <meta name="dtb:depth" content="2"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${xmlEscape(title)}</text></docTitle>
  <navMap>
${points.join("\n")}
  </navMap>
</ncx>
`;
}

const VOID_TAGS = new Set(["br", "hr", "img", "meta", "link", "input", "source", "col"]);

export function htmlToXhtmlFragment(html: string): string {
  if (!html) return "";
  const doc = parseDocument(`<div id="__root">${html}</div>`);
  const root = doc.getElementById("__root");
  if (!root) return "";
  return serializeChildren(root);
}

function serializeChildren(node: Element): string {
  let out = "";
  node.childNodes.forEach((child) => {
    out += serializeNode(child);
  });
  return out;
}

function serializeNode(node: Node): string {
  if (node.nodeType === 3) {
    return xmlEscape(node.textContent ?? "").replace(/&apos;/g, "'");
  }
  if (node.nodeType === 8) return "";
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (tag === "script" || tag === "style") return "";
  if (tag === "a") return serializeChildren(el);
  const attrs: string[] = [];
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name;
    if (name.startsWith("on")) continue;
    attrs.push(`${name}="${xmlEscape(attr.value)}"`);
  }
  const attrStr = attrs.length ? " " + attrs.join(" ") : "";
  if (VOID_TAGS.has(tag)) {
    return `<${tag}${attrStr}/>`;
  }
  const inner = serializeChildren(el);
  return `<${tag}${attrStr}>${inner}</${tag}>`;
}

interface EmbeddedImage {
  localName: string;
  mimeType: string;
  data: Buffer;
}

async function embedImages(
  html: string,
  article: Article,
  http: HttpClient,
  config: AppConfig,
): Promise<{ html: string; images: EmbeddedImage[] }> {
  if (!html) return { html, images: [] };
  const doc = parseDocument(`<div id="__root">${html}</div>`, article.canonicalUrl || article.url);
  const root = doc.getElementById("__root");
  if (!root) return { html, images: [] };
  const images: EmbeddedImage[] = [];
  const used = new Set<string>();
  const imgs = Array.from(root.querySelectorAll("img"));
  let count = 0;
  for (const img of imgs) {
    const src = img.getAttribute("src");
    if (!src || src.startsWith("data:")) {
      img.remove();
      continue;
    }
    if (count >= 15) {
      img.remove();
      continue;
    }
    let absolute: string;
    try {
      absolute = new URL(src, article.canonicalUrl || article.url).href;
    } catch {
      img.remove();
      continue;
    }
    try {
      const policy = await http.isAllowed(absolute);
      if (!policy.allowed) {
        img.remove();
        continue;
      }
      const res = await http.fetchBuffer(absolute, { timeoutMs: Math.min(config.timeoutMs, 15000) });
      if (res.body.length < 64 || res.body.length > config.epub.maxImageBytes) {
        img.remove();
        continue;
      }
      const mime =
        res.headers.get("content-type")?.split(";")[0]?.trim() ||
        guessMime(absolute, res.body) ||
        "image/jpeg";
      if (!mime.startsWith("image/")) {
        img.remove();
        continue;
      }
      const ext = extensionFromMime(mime) || path.posix.extname(new URL(absolute).pathname) || ".jpg";
      let localName = `${article.id}-${hashHex(absolute, 10)}${ext}`;
      if (used.has(localName)) localName = `${article.id}-${images.length}${ext}`;
      used.add(localName);
      images.push({ localName, mimeType: mime, data: res.body });
      img.setAttribute("src", `../images/${localName}`);
      count += 1;
    } catch (err) {
      log.debug("image.skip", {
        url: absolute,
        error: err instanceof Error ? err.message : String(err),
      });
      img.remove();
    }
  }
  return { html: serializeChildren(root), images };
}

function guessMime(url: string, buf: Buffer): string | undefined {
  const ext = path.posix.extname(new URL(url).pathname);
  const fromExt = mimeFromExtension(ext);
  if (fromExt) return fromExt;
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp";
  return undefined;
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, "").trim() || "book";
}


