/**
 * Runtime configuration loaded from environment variables.
 *
 * Mirrors `pocket_id_exporter/config.py` and `tautulli_exporter/config.py`:
 * one immutable Config object, one ConfigError type, one `loadConfig()`
 * factory that throws cleanly so the entrypoint can exit with code 2.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type LogFormat = "text" | "json";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  readonly komodoUrl: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly exporterPort: number;
  readonly fastPollInterval: number;
  readonly slowPollInterval: number;
  readonly metaPollInterval: number;
  readonly requestTimeout: number;
  readonly logLevel: LogLevel;
  readonly logFormat: LogFormat;
}

/** Returns the config as a plain object with secrets redacted, for logging. */
export function sanitized(config: Config): Record<string, unknown> {
  return {
    komodoUrl: config.komodoUrl,
    apiKey: config.apiKey ? "***" : "",
    apiSecret: config.apiSecret ? "***" : "",
    exporterPort: config.exporterPort,
    fastPollInterval: config.fastPollInterval,
    slowPollInterval: config.slowPollInterval,
    metaPollInterval: config.metaPollInterval,
    requestTimeout: config.requestTimeout,
    logLevel: config.logLevel,
    logFormat: config.logFormat,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const komodoUrl = (env.KOMODO_URL ?? "").trim();
  if (!komodoUrl) throw new ConfigError("KOMODO_URL is required");

  const apiKey = (env.KOMODO_API_KEY ?? "").trim();
  if (!apiKey) throw new ConfigError("KOMODO_API_KEY is required");

  const apiSecret = (env.KOMODO_API_SECRET ?? "").trim();
  if (!apiSecret) throw new ConfigError("KOMODO_API_SECRET is required");

  const logFormat = (env.LOG_FORMAT ?? "text").toLowerCase();
  if (logFormat !== "text" && logFormat !== "json") {
    throw new ConfigError(
      `LOG_FORMAT must be 'text' or 'json', got ${JSON.stringify(env.LOG_FORMAT)}`,
    );
  }

  const logLevel = (env.LOG_LEVEL ?? "info").toLowerCase();
  if (!["debug", "info", "warn", "warning", "error"].includes(logLevel)) {
    throw new ConfigError(
      `LOG_LEVEL must be one of debug/info/warn/error, got ${JSON.stringify(env.LOG_LEVEL)}`,
    );
  }

  return Object.freeze({
    komodoUrl: stripTrailingSlash(komodoUrl),
    apiKey,
    apiSecret,
    exporterPort: readInt(env, "EXPORTER_PORT", 9105, { min: 1, max: 65535 }),
    fastPollInterval: readInt(env, "FAST_POLL_INTERVAL", 15, { min: 1 }),
    slowPollInterval: readInt(env, "SLOW_POLL_INTERVAL", 300, { min: 1 }),
    metaPollInterval: readInt(env, "META_POLL_INTERVAL", 1800, { min: 1 }),
    requestTimeout: readInt(env, "REQUEST_TIMEOUT", 30, { min: 1 }),
    logLevel: (logLevel === "warning" ? "warn" : logLevel) as LogLevel,
    logFormat: logFormat,
  });
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function readInt(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number,
  bounds: { min?: number; max?: number } = {},
): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(`${key} must be an integer, got ${JSON.stringify(raw)}`);
  }
  if (bounds.min !== undefined && parsed < bounds.min) {
    throw new ConfigError(`${key} must be >= ${String(bounds.min)}, got ${String(parsed)}`);
  }
  if (bounds.max !== undefined && parsed > bounds.max) {
    throw new ConfigError(`${key} must be <= ${String(bounds.max)}, got ${String(parsed)}`);
  }
  return parsed;
}
