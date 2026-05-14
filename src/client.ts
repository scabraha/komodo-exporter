/**
 * Thin wrapper over the official `komodo_client` package.
 *
 * The vendored client is already type-safe: `read("ListServers", {})` is
 * inferred as `Promise<Types.ListServersResponse>`. We layer on:
 *
 *  - debug-level timing for every call (mirrors PocketIDClient.get())
 *  - a small bounded retry for transient errors (network blips, 5xx)
 *  - a per-request abort timeout, since komodo_client doesn't expose one
 *
 * We deliberately keep the surface minimal — `read()` only — because the
 * exporter never writes or executes anything.
 */

import "./polyfills.js";
import {
  KomodoClient,
  Types,
  type ReadResponses,
} from "komodo_client";
import type { Logger } from "pino";

import type { Config } from "./config.js";

type ReadRequest = Types.ReadRequest;
type ReadType = ReadRequest["type"];
type ParamsFor<T extends ReadType> = Extract<ReadRequest, { type: T }>["params"];

export interface ApiClient {
  read<T extends ReadType>(type: T, params: ParamsFor<T>): Promise<ReadResponses[T]>;
}

interface ClientOptions {
  retries?: number;
  retryBackoffMs?: number;
}

export function createKomodoClient(
  config: Pick<Config, "komodoUrl" | "apiKey" | "apiSecret" | "requestTimeout">,
  log: Logger,
  opts: ClientOptions = {},
): ApiClient {
  const inner = KomodoClient(config.komodoUrl, {
    type: "api-key",
    params: { key: config.apiKey, secret: config.apiSecret },
  });

  const retries = opts.retries ?? 2;
  const backoffMs = opts.retryBackoffMs ?? 500;
  const timeoutMs = config.requestTimeout * 1000;

  async function read<T extends ReadType>(
    type: T,
    params: ParamsFor<T>,
  ): Promise<ReadResponses[T]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const started = performance.now();
      try {
        // The inner client's generic constraint is intersection-typed, which
        // can't be satisfied through a forwarded T — cast the call site once
        // here so consumers still see the strict per-type union.
        const result = (await withTimeout(
          (inner.read as (t: string, p: unknown) => Promise<unknown>)(type, params),
          timeoutMs,
          type,
        )) as ReadResponses[T];
        const ms = Math.round(performance.now() - started);
        log.debug({ method: type, ms, attempt }, "komodo read ok");
        return result;
      } catch (err) {
        lastErr = err;
        const ms = Math.round(performance.now() - started);
        const status = extractStatus(err);
        const retriable =
          attempt < retries &&
          (status === undefined || status >= 500 || status === 429);
        log.debug(
          { method: type, ms, attempt, status, retriable },
          retriable ? "komodo read failed (retrying)" : "komodo read failed",
        );
        if (!retriable) break;
        await sleep(backoffMs * (attempt + 1));
      }
    }
    throw lastErr;
  }

  return { read };
}

function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

async function withTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => { reject(new Error(`komodo ${label} timed out after ${String(timeoutMs)}ms`)); },
      timeoutMs,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { Types, type ReadResponses };

