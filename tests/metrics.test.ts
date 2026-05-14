import { Registry } from "prom-client";
import { describe, expect, it } from "vitest";

import { Types } from "../src/client.js";
import { Metrics, serverStateValue } from "../src/metrics.js";

describe("serverStateValue", () => {
  it("encodes server health as a numeric value", () => {
    expect(serverStateValue(Types.ServerState.Ok)).toBe(1);
    expect(serverStateValue(Types.ServerState.Disabled)).toBe(0);
    expect(serverStateValue(Types.ServerState.NotOk)).toBe(-1);
  });
});

describe("Metrics", () => {
  it("registers all gauges/counters on the supplied registry", async () => {
    const registry = new Registry();
    new Metrics(registry);
    const text = await registry.metrics();

    // Spot-check a representative metric from each section so we catch
    // accidental deletions / renames.
    for (const name of [
      "komodo_servers_total",
      "komodo_stacks_by_state",
      "komodo_deployment_update_available",
      "komodo_build_last_built_timestamp_seconds",
      "komodo_repos_total",
      "komodo_procedures_by_state",
      "komodo_open_alerts",
      "komodo_container_state",
      "komodo_container_created_timestamp_seconds",
      "komodo_core_version_info",
      "komodo_up",
      "komodo_exporter_poll_duration_seconds",
      "komodo_exporter_poll_failures_total",
      "komodo_exporter_last_successful_poll_timestamp_seconds",
    ]) {
      expect(text).toContain(`# HELP ${name}`);
    }
  });
});
