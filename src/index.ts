#!/usr/bin/env node
/**
 * CLI entrypoint. Mirrors `pocket_id_exporter/__main__.py`:
 *
 *   1. load + validate config (exit 2 on bad config)
 *   2. set up logger
 *   3. construct client / metrics / poller
 *   4. start `/metrics` HTTP server
 *   5. install SIGTERM/SIGINT handlers
 *   6. run forever
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Registry } from "prom-client";

import { createKomodoClient } from "./client.js";
import { type Config, ConfigError, loadConfig, sanitized } from "./config.js";
import { createLogger, type Logger } from "./logging.js";
import { Metrics } from "./metrics.js";
import { Poller } from "./poller.js";
import { VERSION } from "./version.js";

async function main(): Promise<number> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  const log = createLogger(config);
  log.info({ version: VERSION }, "komodo-exporter starting");
  log.info({ config: sanitized(config) }, "effective config");

  const registry = new Registry();
  registry.setDefaultLabels({ exporter: "komodo" });

  const metrics = new Metrics(registry);
  const client = createKomodoClient(config, log);
  const poller = new Poller(client, metrics, config, log);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, registry, log);
  });

  server.on("error", (err) => {
    log.error({ err: describe(err), port: config.exporterPort }, "http server error");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.exporterPort, () => {
      server.off("error", reject);
      resolve();
    });
  });
  log.info({ port: config.exporterPort }, "metrics endpoint listening on /metrics");

  const stopPoller = poller.start();

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutting down");
    await Promise.all([
      stopPoller(),
      new Promise<void>((resolve) => server.close(() => { resolve(); })),
    ]);
  };

  let resolveExit: (code: number) => void = () => {
    // overwritten by Promise constructor below
  };
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal).then(() => { resolveExit(0); });
    });
  }

  return exit;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: Registry,
  log: Logger,
): Promise<void> {
  if (!req.url) {
    res.statusCode = 400;
    res.end("bad request");
    return;
  }
  const url = req.url.split("?", 1)[0];
  if (url === "/metrics") {
    try {
      const body = await registry.metrics();
      res.statusCode = 200;
      res.setHeader("Content-Type", registry.contentType);
      res.end(body);
    } catch (err: unknown) {
      log.error({ err: describe(err) }, "failed to render metrics");
      res.statusCode = 500;
      res.end("metrics error");
    }
    return;
  }
  if (url === "/healthz" || url === "/health" || url === "/") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("ok\n");
    return;
  }
  res.statusCode = 404;
  res.end("not found");
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

main()
  .then((code) => { process.exit(code); })
  .catch((err: unknown) => {
    process.stderr.write(`fatal: ${describe(err)}\n`);
    process.exit(1);
  });
