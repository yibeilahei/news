type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: Level = "info";

export function setLogLevel(level: Level): void {
  currentLevel = level;
}

export function getLogLevel(): Level {
  return currentLevel;
}

function write(level: Level, message: string, extra?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const ts = new Date().toISOString();
  const payload = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";
  const line = `[${ts}] ${level.toUpperCase().padEnd(5)} ${message}${payload}`;
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  debug: (message: string, extra?: Record<string, unknown>) => write("debug", message, extra),
  info: (message: string, extra?: Record<string, unknown>) => write("info", message, extra),
  warn: (message: string, extra?: Record<string, unknown>) => write("warn", message, extra),
  error: (message: string, extra?: Record<string, unknown>) => write("error", message, extra),
};

export function formatRunSummary(stats: {
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
}): string {
  const inaccessibleGroup =
    stats.inaccessible + stats.paywalled + stats.duplicates + stats.skippedRobots;
  return [
    "Feeds:",
    `  ${stats.feedsSuccessful} successful`,
    `  ${stats.feedsFailed} failed`,
    "",
    "Articles:",
    `  ${stats.discovered} discovered`,
    `  ${stats.full} full articles`,
    `  ${stats.rssOnly} RSS summaries only`,
    `  ${inaccessibleGroup} inaccessible/duplicates`,
    "",
    "Detail:",
    `  paywalled=${stats.paywalled} inaccessible=${stats.inaccessible} duplicates=${stats.duplicates}`,
    `  cached=${stats.cached} failed=${stats.failed} robots=${stats.skippedRobots}`,
  ].join("\n");
}
