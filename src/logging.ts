/**
 * Logging setup. Wraps `pino` so we get text or JSON output depending on
 * config, mirroring the Python exporters' `LOG_FORMAT=text|json` switch.
 *
 * `text` mode renders a single human-readable line per record using
 * pino-pretty's transport (loaded only when text mode is selected, so the
 * dependency stays optional in practice). If pino-pretty isn't installed
 * (production image keeps it lean), we fall back to plain JSON.
 */

import pino, { type Logger, type LoggerOptions } from "pino";
import type { Config } from "./config.js";

export function createLogger(
  config: Pick<Config, "logLevel" | "logFormat">,
): Logger {
  const baseOptions: LoggerOptions = {
    level: config.logLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    base: { name: "komodo-exporter" },
  };

  if (config.logFormat === "json") {
    return pino(baseOptions);
  }

  // Try pretty-printing; if pino-pretty isn't available, fall back to JSON
  // rather than crashing the process at startup.
  try {
    return pino({
      ...baseOptions,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: false,
          translateTime: "SYS:yyyy-mm-dd'T'HH:MM:sso",
          ignore: "pid,hostname",
          singleLine: true,
        },
      },
    });
  } catch {
    return pino(baseOptions);
  }
}

export type { Logger };
