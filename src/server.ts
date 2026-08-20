import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readdirSync, statSync, createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "./log.js";
import { xmlEscape } from "./util.js";

export function startServer(opts: {
  root: string;
  host: string;
  port: number;
}): ReturnType<typeof createServer> {
  const root = path.resolve(opts.root);
  const server = createServer((req, res) => {
    handle(req, res, root).catch((err) => {
      log.error("server.error", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("Internal error");
    });
  });
  server.listen(opts.port, opts.host, () => {
    log.info("server.listen", { host: opts.host, port: opts.port, root });
    for (const url of localUrls(opts.port)) {
      log.info("server.url", { url });
    }
  });
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const listing = listEpubs(root);
    const html = indexHtml(listing);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(html);
    return;
  }

  const decoded = decodeURIComponent(url.pathname);
  const safe = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(root, safe);
  if (!filePath.startsWith(root) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  if (!filePath.toLowerCase().endsWith(".epub")) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Only EPUB files are served");
    return;
  }
  const stat = statSync(filePath);
  res.writeHead(200, {
    "Content-Type": "application/epub+zip",
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

function listEpubs(root: string): { name: string; size: number; mtime: Date }[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.toLowerCase().endsWith(".epub"))
    .map((name) => {
      const st = statSync(path.join(root, name));
      return { name, size: st.size, mtime: st.mtime };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

function indexHtml(files: { name: string; size: number; mtime: Date }[]): string {
  const rows = files
    .map((f) => {
      const href = "/" + encodeURIComponent(f.name);
      const size = (f.size / 1024).toFixed(0) + " KB";
      return `<li><a href="${href}">${xmlEscape(f.name)}</a> <span>${size} · ${xmlEscape(f.mtime.toISOString())}</span></li>`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>rss2epub</title>
  <style>
    body { font-family: sans-serif; margin: 1.5em; line-height: 1.6; }
    li { margin: 0.4em 0; }
    span { color: #555; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>rss2epub</h1>
  <p>生成済み EPUB（端末のブラウザからダウンロードできます）</p>
  <ul>
    ${rows || "<li>まだ EPUB がありません。<code>rss2epub update</code> を実行してください。</li>"}
  </ul>
</body>
</html>
`;
}

export function localUrls(port: number): string[] {
  const urls = [`http://127.0.0.1:${port}/`];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.internal || addr.family !== "IPv4") continue;
      urls.push(`http://${addr.address}:${port}/`);
    }
  }
  return urls;
}
