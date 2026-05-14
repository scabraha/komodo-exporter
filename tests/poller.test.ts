import { Registry } from "prom-client";
import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/client.js";
import { Types } from "../src/client.js";
import type { Config } from "../src/config.js";
import { Metrics } from "../src/metrics.js";
import { Poller } from "../src/poller.js";

const config: Config = Object.freeze({
  komodoUrl: "https://komo.example.com",
  apiKey: "k",
  apiSecret: "s",
  exporterPort: 9105,
  fastPollInterval: 1,
  slowPollInterval: 1,
  metaPollInterval: 1,
  requestTimeout: 30,
  logLevel: "error",
  logFormat: "json",
});

const silentLog = {
  debug: () => { /* no-op for tests */ },
  info: () => { /* no-op for tests */ },
  warn: () => { /* no-op for tests */ },
  error: () => { /* no-op for tests */ },
} as unknown as Parameters<typeof Poller.prototype.constructor>[3];

interface FakeReadResponses {
  GetServersSummary: { total: number; healthy: number; unhealthy: number; disabled: number; warning: number };
  ListServers: { name: string; info: { state: Types.ServerState; region: string } }[];
  ListAllDockerContainers: {
    server_id?: string;
    name: string;
    image?: string;
    state: Types.ContainerStateStatusEnum;
    created?: number;
  }[];
  ListAlerts: { alerts: { level: Types.SeverityLevel; data: { type: string } }[] };
}

function fakeClient(responses: Partial<FakeReadResponses>): ApiClient {
  return {
    read: vi.fn((type: string) => {
      if (!(type in responses)) {
        return Promise.reject(new Error(`unexpected read: ${type}`));
      }
      return Promise.resolve((responses as Record<string, unknown>)[type]);
    }) as unknown as ApiClient["read"],
  };
}

describe("Poller fast tier", () => {
  it("populates server, container, and alert metrics from a successful poll", async () => {
    const client = fakeClient({
      GetServersSummary: { total: 3, healthy: 2, unhealthy: 1, disabled: 0, warning: 0 },
      ListServers: [
        { name: "edge", info: { state: Types.ServerState.Ok, region: "us-east" } },
        { name: "lab", info: { state: Types.ServerState.NotOk, region: "" } },
      ],
      ListAllDockerContainers: [
        {
          server_id: "srv1",
          name: "nginx",
          image: "nginx:1.25",
          state: Types.ContainerStateStatusEnum.Running,
          created: 1_700_000_000_000,
        },
      ],
      ListAlerts: {
        alerts: [
          { level: Types.SeverityLevel.Critical, data: { type: "ServerCpu" } },
          { level: Types.SeverityLevel.Critical, data: { type: "ServerCpu" } },
          { level: Types.SeverityLevel.Warning, data: { type: "ServerMem" } },
        ],
      },
    });

    const registry = new Registry();
    const metrics = new Metrics(registry);
    const poller = new Poller(client, metrics, config, silentLog);

    // Drive a single fast-tier pass via the private runner.
    await (poller as unknown as {
      runTier: (tier: string, steps: { name: string; fn: () => Promise<void> }[]) => Promise<void>;
    }).runTier("fast", [
      { name: "servers", fn: () => (poller as unknown as { pollServers: () => Promise<void> }).pollServers() },
      { name: "containers", fn: () => (poller as unknown as { pollContainers: () => Promise<void> }).pollContainers() },
      { name: "alerts", fn: () => (poller as unknown as { pollAlerts: () => Promise<void> }).pollAlerts() },
    ]);

    const text = await registry.metrics();
    expect(text).toMatch(/komodo_servers_total \d+/);
    expect(text).toContain("komodo_servers_total 3");
    expect(text).toContain('komodo_servers_by_state{state="healthy"} 2');
    expect(text).toContain('komodo_server_state{name="edge",region="us-east"} 1');
    expect(text).toContain('komodo_server_state{name="lab",region=""} -1');
    expect(text).toContain(
      'komodo_container_state{server_id="srv1",container="nginx",image="nginx:1.25",state="running"} 1',
    );
    expect(text).toMatch(
      /komodo_container_created_timestamp_seconds\{server_id="srv1",container="nginx",image="nginx:1.25"\} 1700000000/,
    );
    expect(text).toContain(
      'komodo_open_alerts{level="CRITICAL",type="ServerCpu"} 2',
    );
    expect(text).toContain('komodo_up 1');
  });

  it("flips komodo_up to 0 and increments failure counter on any step error", async () => {
    const client = fakeClient({
      // Missing GetServersSummary etc — every read throws.
    });

    const registry = new Registry();
    const metrics = new Metrics(registry);
    const poller = new Poller(client, metrics, config, silentLog);

    await (poller as unknown as {
      runTier: (tier: string, steps: { name: string; fn: () => Promise<void> }[]) => Promise<void>;
    }).runTier("fast", [
      { name: "servers", fn: () => (poller as unknown as { pollServers: () => Promise<void> }).pollServers() },
    ]);

    const text = await registry.metrics();
    expect(text).toContain("komodo_up 0");
    expect(text).toContain(
      'komodo_exporter_poll_failures_total{tier="fast",step="servers"} 1',
    );
  });
});
